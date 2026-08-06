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
 * 3. When `imagesNeedRedraw` is true, ALL rows are force-redrawn (the row-skip
 *    gate is disabled), not just the changed rows.
 *
 * The fix:
 * - Always run `prepareKittyScreen()` for Kitty protocol, so image lines use
 *   placement-only commands (~50 bytes) instead of re-transmitting base64.
 * - Store prepared (placement-converted) lines in `previousScreen` so the next
 *   frame compares placement vs placement consistently.
 * - After `deleteAllKittyPlacements()` (still needed — Kitty has no per-image
 *   placement deletion), only redraw image rows + changed text rows, not ALL
 *   rows. Unchanged text rows are skipped.
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

// Layout/render helpers imported from pi-tui's dist (not all exported from index).
type LayoutModule = {
  renderLayoutFrame: (
    root: unknown,
    width: number,
    height: number,
    requestRender: () => void
  ) => { lines: string[]; primaryScrollView?: unknown };
};

type KittyImagePlacement = {
  imageId: number;
  sequence: string;
  replacementLine: string;
};

type TerminalImageModule = {
  isImageLine: (line: string) => boolean;
  deleteAllKittyPlacements: () => string;
  getKittyImagePlacement: (line: string) => KittyImagePlacement | undefined;
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
 * The patched doRender — a copy of the upstream method with the three fixes
 * described in the file-level comment. Accesses private fields via `any` cast
 * because they are not on the public type surface.
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

  let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
  // Detect if any image row changed (crop params, new image, removed image).
  const preparedLines = preparedKittyScreen.lines;
  const imagesNeedRedraw =
    !fullRedraw &&
    this.imageProtocol === "kitty" &&
    preparedLines.some(
      (line, row) =>
        line !== this.previousScreen[row] &&
        (terminalImageMod!.isImageLine(line) ||
          terminalImageMod!.isImageLine(this.previousScreen[row] ?? ""))
    );
  if (fullRedraw) {
    this.fullRedrawCount += 1;
    const clearImages =
      this.imageProtocol === "kitty" && hadUploadedKittyImages
        ? terminalImageMod!.deleteAllKittyPlacements()
        : this.deleteKittyImages();
    buffer += `${clearImages}\x1b[2J`;
  } else if (imagesNeedRedraw) {
    // Kitty has no per-image placement deletion, so we must delete all
    // placements. But unlike upstream, we only redraw image rows + changed
    // text rows — unchanged text rows are skipped.
    if (this.imageProtocol === "iterm2") {
      buffer += "\x1b[2J";
    } else if (this.imageProtocol === "kitty") {
      buffer += terminalImageMod!.deleteAllKittyPlacements();
    }
  }
  buffer += preparedKittyScreen.evictedImageDeletion;
  for (let row = 0; row < height; row++) {
    if (!fullRedraw && preparedLines[row] === this.previousScreen[row]) {
      // After deleteAllKittyPlacements(), unchanged image rows must still be
      // re-placed because their placement was deleted.
      if (
        imagesNeedRedraw &&
        terminalImageMod!.isImageLine(preparedLines[row] ?? "")
      ) {
        // fall through to render
      } else {
        continue;
      }
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
