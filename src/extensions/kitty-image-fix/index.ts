import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Monkey-patch TuiAltScreen.doRender to eliminate Kitty image flickering when
 * scrolling. The upstream implementation (pi-tui <= 0.84.0) has three problems:
 *
 * 1. `prepareKittyScreen()` (which converts already-uploaded image lines to
 *    cheap placement-only `a=p` commands) only runs when `redrawImages=true`.
 * 2. `previousScreen` stores raw screen lines, not placement-converted lines,
 *    so the row comparison is inconsistent and `imagesNeedRedraw` is true on
 *    every scroll frame (crop params always differ).
 * 3. When `imagesNeedRedraw` is true, `deleteAllKittyPlacements()` nukes ALL
 *    image placements and ALL rows are force-redrawn — causing flicker.
 *
 * The fix:
 * - Always run `prepareKittyScreen()` for Kitty protocol, so image lines use
 *   placement-only commands (~50 bytes) instead of re-transmitting base64.
 * - Store prepared (placement-converted) lines in `previousScreen` so the next
 *   frame compares placement vs placement consistently.
 * - For non-full-redraw frames, delete placements for ONLY the image IDs on
 *   changed rows (via `a=d,d=p,i=X`) instead of `deleteAllKittyPlacements()`.
 *   This keeps unchanged images on screen without re-placing them.
 * - Only redraw changed rows — unchanged text AND image rows are skipped.
 */

const PATCH_STATE = Symbol.for("hd-agent.kitty-image-fix");

type DoRender = () => void;

type TuiAltScreenLike = {
  readonly prototype: {
    doRender: DoRender;
    [PATCH_STATE]?: true;
  };
};

type TuiAltScreenInstance = {
  stopped: boolean;
  altScreenActive: boolean;
  readonly terminal: {
    columns: number;
    rows: number;
    write: (data: string) => void;
  };
  layoutRoot: unknown;
  readonly implicitScrollView: unknown;
  previousScreen: string[];
  previousScreenWidth: number;
  previousScreenHeight: number;
  imageProtocol: "kitty" | "iterm2" | null;
  readonly uploadedKittyImages: Map<number, unknown>;
  fullRedrawCount: number;
  currentLayout: unknown;
  requestRender: () => void;
  compositeOverlays: (
    screen: string[],
    width: number,
    height: number
  ) => string[];
  applySelection: (screen: string[], layout: unknown) => string[];
  compositeFlashes: (
    screen: string[],
    width: number,
    height: number
  ) => string[];
  extractCursorPosition: (
    screen: string[],
    height: number
  ) => { row: number; col: number } | null;
  applyLineResets: (screen: string[]) => string[];
  getShowHardwareCursor: () => boolean;
  prepareKittyScreen: (screen: string[]) => {
    lines: string[];
    evictedImageDeletion: string;
  };
  deleteKittyImages: () => string;
};

// Constants duplicated from tui-alt-screen.js (not exported upstream).
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const KITTY_PREFIX = "\x1b_G";
const KITTY_TERMINATOR = "\x1b\\";

// Layout/render helpers imported from pi-tui's dist (not all exported from index).
type LayoutModule = {
  renderLayoutFrame: (
    root: unknown,
    width: number,
    height: number,
    requestRender: () => void
  ) => { lines: string[]; primaryScrollView?: unknown };
};

type TerminalImageModule = {
  isImageLine: (line: string) => boolean;
  deleteAllKittyPlacements: () => string;
};

type UtilsModule = {
  visibleWidth: (line: string) => number;
  sliceByColumn: (
    line: string,
    start: number,
    width: number,
    preserveStyle?: boolean
  ) => string;
};

let layoutMod: LayoutModule | undefined;
let terminalImageMod: TerminalImageModule | undefined;
let utilsMod: UtilsModule | undefined;

function loadModules(piTuiDistDir: string): void {
  if (layoutMod && terminalImageMod && utilsMod) {
    return;
  }
  const require = createRequire(join(piTuiDistDir, "index.js"));
  layoutMod = require("./layout.js") as LayoutModule;
  terminalImageMod = require("./terminal-image.js") as TerminalImageModule;
  utilsMod = require("./utils.js") as UtilsModule;
}

/**
 * Extract the image ID (`i=` param) from a Kitty graphics command line.
 * Works with both transmission lines (`a=T,...;base64`) and placement-only
 * lines (`a=p,q=2,...`) — the upstream `getKittyImagePlacement()` only handles
 * transmission lines because it requires a `;` separator.
 */
function extractKittyImageId(line: string): number | undefined {
  const seqStart = line.indexOf(KITTY_PREFIX);
  if (seqStart === -1) {
    return undefined;
  }
  const paramsStart = seqStart + KITTY_PREFIX.length;
  // Find end of control params: either `;` (transmission) or `\x1b\\` (placement-only)
  const semiIdx = line.indexOf(";", paramsStart);
  const termIdx = line.indexOf(KITTY_TERMINATOR, paramsStart);
  let paramsEnd: number;
  if (semiIdx !== -1 && (termIdx === -1 || semiIdx < termIdx)) {
    paramsEnd = semiIdx;
  } else if (termIdx !== -1) {
    paramsEnd = termIdx;
  } else {
    return undefined;
  }
  const params = line.slice(paramsStart, paramsEnd);
  for (const param of params.split(",")) {
    const eqIdx = param.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    if (param.slice(0, eqIdx) === "i") {
      const val = Number(param.slice(eqIdx + 1));
      if (Number.isInteger(val) && val > 0) {
        return val;
      }
    }
  }
  return undefined;
}

function isTuiAltScreenConstructor(value: unknown): value is TuiAltScreenLike {
  if (typeof value !== "function") {
    return false;
  }
  const proto = (value as { prototype?: unknown }).prototype;
  return (
    !!proto && typeof (proto as { doRender?: unknown }).doRender === "function"
  );
}

/**
 * The patched doRender — a copy of the upstream method with the fixes
 * described in the file-level comment.
 */
function patchedDoRender(this: TuiAltScreenInstance): void {
  if (this.stopped || !this.altScreenActive) {
    return;
  }

  const width = Math.max(1, this.terminal.columns);
  const height = Math.max(1, this.terminal.rows);
  const root = this.layoutRoot ?? this.implicitScrollView;
  const nextLayout = layoutMod!.renderLayoutFrame(root, width, height, () =>
    this.requestRender()
  );
  let screen = nextLayout.lines.map((line) =>
    line.replace(OSC133_ZONE_PREFIX, "")
  );
  screen = this.compositeOverlays(screen, width, height);
  if (screen.length > height) {
    screen = screen.slice(screen.length - height);
  }
  screen = this.applySelection(screen, nextLayout);
  screen = this.compositeFlashes(screen, width, height);
  const cursorPos = this.extractCursorPosition(screen, height);
  screen = this.applyLineResets(screen).map((line) => {
    if (
      terminalImageMod!.isImageLine(line) ||
      utilsMod!.visibleWidth(line) <= width
    ) {
      return line;
    }
    return utilsMod!.sliceByColumn(line, 0, width, true);
  });

  const fullRedraw =
    this.previousScreen.length === 0 ||
    this.previousScreenWidth !== width ||
    this.previousScreenHeight !== height;
  const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
  const preparedKittyScreen =
    this.imageProtocol === "kitty"
      ? this.prepareKittyScreen(screen)
      : { lines: screen, evictedImageDeletion: "" };

  const preparedLines = preparedKittyScreen.lines;

  let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
  if (fullRedraw) {
    this.fullRedrawCount += 1;
    const clearImages =
      this.imageProtocol === "kitty" && hadUploadedKittyImages
        ? terminalImageMod!.deleteAllKittyPlacements()
        : this.deleteKittyImages();
    buffer += `${clearImages}\x1b[2J`;
  } else if (this.imageProtocol === "kitty") {
    // Delete placements for ONLY the image IDs on changed rows, instead of
    // deleteAllKittyPlacements(). This keeps unchanged images on screen
    // without re-placing them, eliminating flicker.
    const changedImageIds = new Set<number>();
    for (let row = 0; row < height; row++) {
      if (preparedLines[row] === this.previousScreen[row]) {
        continue;
      }
      const oldLine = this.previousScreen[row] ?? "";
      const newLine = preparedLines[row] ?? "";
      if (terminalImageMod!.isImageLine(oldLine)) {
        const id = extractKittyImageId(oldLine);
        if (id !== undefined) {
          changedImageIds.add(id);
        }
      }
      if (terminalImageMod!.isImageLine(newLine)) {
        const id = extractKittyImageId(newLine);
        if (id !== undefined) {
          changedImageIds.add(id);
        }
      }
    }
    for (const imageId of changedImageIds) {
      buffer += `\x1b_Ga=d,d=p,i=${imageId},q=2\x1b\\`;
    }
  }
  buffer += preparedKittyScreen.evictedImageDeletion;
  for (let row = 0; row < height; row++) {
    if (!fullRedraw && preparedLines[row] === this.previousScreen[row]) {
      continue;
    }
    buffer += `\x1b[${row + 1};1H\x1b[2K${preparedLines[row] ?? ""}`;
  }
  if (cursorPos) {
    buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
    buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
  } else {
    buffer += "\x1b[?25l";
  }
  buffer += END_SYNCHRONIZED_OUTPUT;
  this.terminal.write(buffer);
  this.previousScreen = preparedKittyScreen.lines;
  this.previousScreenWidth = width;
  this.previousScreenHeight = height;
  this.currentLayout = nextLayout;
}

// ── Module resolution (same pattern as markdown-code) ──────────────────

function processEntryPoints(): string[] {
  const entries: string[] = [];
  const argv1 = process.argv[1];
  if (argv1) {
    entries.push(argv1);
  }
  const bunMain =
    typeof Bun !== "undefined" ? (Bun as { main?: string }).main : undefined;
  if (bunMain && bunMain !== argv1) {
    entries.push(bunMain);
  }
  return entries;
}

function resolvePiTuiDistDirs(entry: string): string[] {
  const dirs = new Set<string>();
  try {
    const resolved = createRequire(entry).resolve("@earendil-works/pi-tui");
    dirs.add(dirname(resolved));
  } catch {
    // Continue with manual walk.
  }
  let dir = dirname(entry);
  while (true) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist"
    );
    if (existsSync(join(candidate, "index.js"))) {
      dirs.add(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return [...dirs];
}

const patchedConstructors: Array<{
  readonly prototype: { doRender: DoRender; [PATCH_STATE]?: true };
  readonly original: DoRender;
}> = [];

function patchTuiAltScreen(ctor: TuiAltScreenLike, distDir: string): boolean {
  const prototype = ctor.prototype;
  if (prototype[PATCH_STATE]) {
    return false;
  }
  loadModules(distDir);
  const original = prototype.doRender;
  prototype[PATCH_STATE] = true;
  prototype.doRender = patchedDoRender as DoRender;
  patchedConstructors.push({ prototype, original });
  return true;
}

export function restoreKittyImageFixPatches(): void {
  for (const { prototype, original } of patchedConstructors.splice(0)) {
    prototype.doRender = original;
    delete prototype[PATCH_STATE];
  }
}

export async function applyKittyImageFixPatches(): Promise<number> {
  let patched = 0;
  for (const entry of processEntryPoints()) {
    for (const distDir of resolvePiTuiDistDirs(entry)) {
      try {
        const mod = (await import(
          pathToFileURL(join(distDir, "index.js")).href
        )) as {
          TuiAltScreen?: unknown;
        };
        if (isTuiAltScreenConstructor(mod.TuiAltScreen)) {
          if (patchTuiAltScreen(mod.TuiAltScreen, distDir)) {
            patched++;
          }
        }
      } catch {
        // Ignore unreadable runtime modules.
      }
    }
  }
  return patched;
}

export default async function (_pi: ExtensionAPI): Promise<void> {
  await applyKittyImageFixPatches();
  _pi.on("session_start", async () => {
    await applyKittyImageFixPatches();
  });
}
