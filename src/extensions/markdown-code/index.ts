import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Markdown as LocalMarkdown,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

const PATCH_STATE = Symbol.for("pim.markdown-code-renderer");

type CodeToken = {
  readonly type: string;
  readonly text?: string;
  readonly lang?: string;
};

function isMermaid(token: CodeToken): boolean {
  return (
    token.type === "code" &&
    token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid"
  );
}

type RenderToken = (
  this: unknown,
  token: CodeToken,
  width: number,
  nextTokenType?: string,
  styleContext?: unknown
) => string[];

type MarkdownConstructor = Function & {
  readonly prototype: MarkdownRenderPrototype;
};

type MarkdownRenderPrototype = {
  renderToken: RenderToken;
  [PATCH_STATE]?: true;
};

function getMarkdownTheme(instance: unknown): MarkdownTheme {
  // Markdown.theme is private in the published types; access via bracket to
  // keep the runtime patch typed without casting the whole prototype to never.
  return (instance as { theme: MarkdownTheme }).theme;
}

/**
 * Amp-style fenced code blocks: keep indent + syntax highlight, drop the
 * literal ```lang / ``` fence chrome that Pi's default Markdown renderer draws.
 */
export function renderAmpCodeBlock(
  theme: MarkdownTheme,
  token: { readonly text?: string; readonly lang?: string },
  nextTokenType?: string
): string[] {
  const indent = theme.codeBlockIndent ?? "  ";
  const source = token.text ?? "";
  const lines: string[] = [];

  if (theme.highlightCode) {
    for (const hlLine of theme.highlightCode(source, token.lang)) {
      lines.push(`${indent}${hlLine}`);
    }
  } else {
    for (const codeLine of source.split("\n")) {
      lines.push(`${indent}${theme.codeBlock(codeLine)}`);
    }
  }

  if (nextTokenType && nextTokenType !== "space") {
    lines.push("");
  }

  return lines;
}

function isMarkdownConstructor(value: unknown): value is MarkdownConstructor {
  const ctor = value as MarkdownConstructor | undefined;
  return (
    typeof ctor === "function" &&
    !!ctor.prototype &&
    typeof ctor.prototype.renderToken === "function"
  );
}

const patchedConstructors: Array<{
  readonly prototype: MarkdownRenderPrototype;
  readonly original: RenderToken;
}> = [];

function patchMarkdown(Markdown: MarkdownConstructor): boolean {
  const prototype = Markdown.prototype;
  if (prototype[PATCH_STATE]) {
    return false;
  }

  const originalRenderToken = prototype.renderToken;
  prototype[PATCH_STATE] = true;

  prototype.renderToken = function (
    token: CodeToken,
    width: number,
    nextTokenType?: string,
    styleContext?: unknown
  ): string[] {
    if (token.type === "code" && !isMermaid(token)) {
      return renderAmpCodeBlock(getMarkdownTheme(this), token, nextTokenType);
    }
    return originalRenderToken.call(
      this,
      token,
      width,
      nextTokenType,
      styleContext
    );
  };

  patchedConstructors.push({ prototype, original: originalRenderToken });
  return true;
}

/** Undo every prototype patch applied by {@link applyMarkdownCodePatches}. */
export function restoreMarkdownPatches(): void {
  for (const { prototype, original } of patchedConstructors.splice(0)) {
    prototype.renderToken = original;
    delete prototype[PATCH_STATE];
  }
}

function processEntryPoints(): string[] {
  const entries: string[] = [];
  const argv1 = process.argv[1];
  if (argv1) {
    entries.push(argv1);
  }
  // HD Agent: `bun /path/to/pi-coding-agent/dist/cli.js ...` → Bun.main is cli.js
  const bunMain =
    typeof Bun !== "undefined" ? (Bun as { main?: string }).main : undefined;
  if (bunMain && bunMain !== argv1) {
    entries.push(bunMain);
  }
  return entries;
}

/**
 * Find every pi-tui installation reachable from an entry point.
 *
 * Do not stop at Node's first resolution result: HD Agent can have both a
 * top-level pi-tui and a copy nested under pi-coding-agent. Depending on how
 * Pi was installed, extensions and the interactive UI may use different
 * copies, so both Markdown prototypes must be patched.
 */
export function resolvePiTuiPathsFromEntry(entry: string): string[] {
  const paths = new Set<string>();

  try {
    paths.add(createRequire(entry).resolve("@earendil-works/pi-tui"));
  } catch {
    // Continue with the manual walk — some entry shims are not valid require roots.
  }

  // Walk all the way up from the CLI file. This discovers both nested and
  // hoisted installs instead of returning only whichever one require.resolve
  // happens to select first.
  let dir = dirname(entry);
  while (true) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist",
      "index.js"
    );
    if (existsSync(candidate)) {
      paths.add(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return [...paths];
}

/**
 * Under Bun (`hd-agent`), jiti aliasing does not force extensions onto Pi's
 * bundled `pi-tui` instance. A plain `import { Markdown } from "pi-tui"` then
 * patches HD Agent's copy while the UI still renders with Pi's copy — fences
 * remain. Resolve every reachable Markdown constructor and patch them all.
 */
export async function resolveMarkdownConstructors(): Promise<
  MarkdownConstructor[]
> {
  const constructors = new Map<object, MarkdownConstructor>();

  const add = (value: unknown): void => {
    if (isMarkdownConstructor(value)) {
      constructors.set(value, value);
    }
  };

  add(LocalMarkdown);

  for (const entry of processEntryPoints()) {
    for (const resolved of resolvePiTuiPathsFromEntry(entry)) {
      try {
        const mod = (await import(pathToFileURL(resolved).href)) as {
          Markdown?: unknown;
        };
        add(mod.Markdown);
      } catch {
        // Ignore unreadable runtime modules; other copies may still work.
      }
    }
  }

  return [...constructors.values()];
}

// Resolution walks existsSync up to the filesystem root and imports every
// candidate module — dozens of blocking syscalls. The set of reachable pi-tui
// copies is fixed for the process lifetime (a /reload re-imports this module,
// resetting the cache), so resolve once and re-patch from the cached list.
let constructorsPromise: Promise<MarkdownConstructor[]> | undefined;

export async function applyMarkdownCodePatches(): Promise<number> {
  constructorsPromise ??= resolveMarkdownConstructors();
  let patched = 0;
  for (const Markdown of await constructorsPromise) {
    if (patchMarkdown(Markdown)) {
      patched++;
    }
  }
  return patched;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Await so the runtime constructor is patched before the first render.
  await applyMarkdownCodePatches();

  // Re-apply after /reload in case a fresh Markdown copy appears.
  pi.on("session_start", async () => {
    await applyMarkdownCodePatches();
  });
}
