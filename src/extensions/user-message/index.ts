import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  UserMessageComponent as UserMessageComponentType,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const PATCH_STATE = Symbol.for("pim.user-message-renderer");
const RENDER_CACHE = Symbol.for("pim.user-message-render-cache");

type RenderCache = {
  baseLines: string[];
  width: number;
  theme: Theme;
  result: string[];
};

type UserMessagePrototype = UserMessageComponentType & {
  [PATCH_STATE]?: {
    theme: Theme;
  };
  [RENDER_CACHE]?: RenderCache;
};

type UserMessageConstructor = Function & {
  readonly prototype: UserMessagePrototype;
};

function isUserMessageConstructor(
  value: unknown
): value is UserMessageConstructor {
  const ctor = value as UserMessageConstructor | undefined;
  return (
    typeof ctor === "function" &&
    !!ctor.prototype &&
    typeof ctor.prototype.render === "function"
  );
}

/**
 * HD Agent can end up with two `pi-coding-agent` copies: one hoisted next to the
 * extension and one nested in the installed package tree. Patching only the
 * imported copy leaves the running UI on the other class, so the quote bar
 * silently disappears. Resolve every reachable copy from the CLI entry point.
 */
async function resolveUserMessageConstructors(): Promise<
  UserMessageConstructor[]
> {
  const constructors = new Set<UserMessageConstructor>();

  const entries = new Set<string>();
  const argv1 = process.argv[1];
  if (argv1) {
    entries.add(argv1);
  }
  const bunMain = typeof Bun !== "undefined" ? Bun.main : undefined;
  if (bunMain) {
    entries.add(bunMain);
  }

  const modulePaths = new Set<string>();
  for (const entry of entries) {
    try {
      modulePaths.add(
        createRequire(entry).resolve("@earendil-works/pi-coding-agent")
      );
    } catch {
      // Some entry shims are not valid require roots; the manual walk covers them.
    }
    let dir = dirname(entry);
    while (true) {
      const candidate = join(
        dir,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "index.js"
      );
      if (existsSync(candidate)) {
        modulePaths.add(candidate);
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  for (const modulePath of modulePaths) {
    try {
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        UserMessageComponent?: unknown;
      };
      if (isUserMessageConstructor(mod.UserMessageComponent)) {
        constructors.add(mod.UserMessageComponent);
      }
    } catch {
      // Ignore unreadable copies; the others may still be the live one.
    }
  }

  return [...constructors];
}

function isBlank(line: string): boolean {
  return Bun.stripANSI(line).trim().length === 0;
}

export function renderAmpUserMessage(
  lines: string[],
  width: number,
  theme: Theme
): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? "")) {
    start++;
  }
  while (end > start && isBlank(lines[end - 1] ?? "")) {
    end--;
  }
  if (start === end) {
    return [];
  }

  const rendered = lines.slice(start, end).map((line) => {
    const content = line.startsWith(" ") ? line.slice(1) : line;
    const prefix = theme.fg("success", "│") + " ";
    return truncateToWidth(prefix + theme.italic(content), width, "");
  });
  rendered[0] = OSC133_ZONE_START + rendered[0];
  rendered[rendered.length - 1] =
    OSC133_ZONE_END + OSC133_ZONE_FINAL + rendered[rendered.length - 1];
  return rendered;
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    for (const ctor of await resolveUserMessageConstructors()) {
      const prototype = ctor.prototype;
      const existing = prototype[PATCH_STATE];
      if (existing) {
        existing.theme = ctx.ui.theme;
        continue;
      }

      const originalRender = prototype.render;
      prototype[PATCH_STATE] = { theme: ctx.ui.theme };
      prototype.render = function (width: number): string[] {
        const lines = originalRender.call(this, width);
        const state = prototype[PATCH_STATE];
        if (!state) {
          return lines;
        }
        // The TUI re-renders every frame; re-styling runs grapheme
        // segmentation per line. The base component caches its content, so
        // when the incoming lines are unchanged (`===` hits the identical-ref
        // fast path for all but the two OSC-marked boundary lines), reuse the
        // previous result.
        const self = this as UserMessagePrototype;
        const cache = self[RENDER_CACHE];
        if (
          cache &&
          cache.width === width &&
          cache.theme === state.theme &&
          cache.baseLines.length === lines.length &&
          cache.baseLines.every((line, i) => line === lines[i])
        ) {
          return cache.result;
        }
        const result = renderAmpUserMessage(lines, width, state.theme);
        self[RENDER_CACHE] = {
          baseLines: lines,
          width,
          theme: state.theme,
          result,
        };
        return result;
      };
    }
  });
}
