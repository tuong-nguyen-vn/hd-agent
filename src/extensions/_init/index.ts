import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DiffRenderer } from "../../shared/DiffRenderer";
import { Tools } from "../../shared/Tools";

const SPLASH_ID = "pim-splash";

function isAbortError(reason: unknown): boolean {
  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return reason.name === "AbortError";
  }
  return reason instanceof Error && reason.name === "AbortError";
}

const ABORT_GUARD = Symbol.for("pim.abort-guard");

// Pressing Escape aborts the active tool/stream signal. Some cancellable work
// (fetch, worker requests, subagent sessions) only surfaces that as a
// rejected promise after the synchronous abort() call has already returned,
// once nothing is left to await it. Swallow only AbortError here so
// cancellation is a no-op from the user's perspective; anything else is
// logged (not hidden) instead of taking down the session. /reload re-imports
// this module, so a process-wide flag keeps it to one listener.
if (!(globalThis as Record<symbol, unknown>)[ABORT_GUARD]) {
  (globalThis as Record<symbol, unknown>)[ABORT_GUARD] = true;
  process.on("unhandledRejection", (reason) => {
    if (isAbortError(reason)) {
      return;
    }
    console.error("pim: unhandled rejection:", reason);
  });
}

const shortcuts = [
  ["Ctrl+C", "Clear editor (first) / exit (second)"],
  ["Escape", "Cancel autocomplete / abort streaming"],
  ["/<command>", "Slash commands", "<command>"],
  ["/hotkeys", "Show all keyboard shortcuts"],
  ["/settings", "Open settings menu"],
  ["@<path>", "Attach files", "<path>"],
  ["@@<query>", "Reference a previous workspace session", "<query>"],
  ["!<command>", "Run bash command", "<command>"],
  ["!!<command>", "Run bash command (excluded from context)", "<command>"],
] as const;

export default async function (pi: ExtensionAPI): Promise<void> {
  if (typeof Bun === "undefined") {
    throw new Error(
      "HD Agent requires the Bun runtime.\n" +
        "Install HD Agent: bun install -g github:tuong-nguyen-vn/hd-agent\n" +
        "Then run: hd-agent\n" +
        "If hd-agent cannot locate Pi, ensure `pi` is on PATH or set PIM_PI_CLI=/path/to/cli.js"
    );
  }

  const pkgPath = `${import.meta.dir}/../../../package.json`;
  const { version } = (await Bun.file(pkgPath).json()) as { version: string };

  const keyCol = Math.max(...shortcuts.map(([k]) => k.length)) + 2;

  let splashShown = false;

  pi.on("session_start", async (event, ctx) => {
    await Tools.ready;
    // Warm the diff highlighter here rather than at module load: the import
    // is heavy, and off the registration path it lands long before the first
    // edit/write/apply_patch result needs to render.
    void DiffRenderer.ready;
    ctx.ui.setHiddenThinkingLabel("✓ Thinking...");

    if (event.reason !== "startup" && event.reason !== "new") {
      return;
    }

    const theme = ctx.ui.theme;
    const renderKey = (key: string, muted: string | undefined): string => {
      const padding = " ".repeat(Math.max(0, keyCol - key.length));
      if (!muted) {
        return theme.fg("mdCode", key + padding);
      }
      const idx = key.indexOf(muted);
      if (idx === -1) {
        return theme.fg("mdCode", key + padding);
      }
      return (
        theme.fg("mdCode", key.slice(0, idx)) +
        theme.fg("muted", muted) +
        key.slice(idx + muted.length) +
        padding
      );
    };

    const title =
      theme.bold(theme.fg("accent", "HDWEBSOFT AGENTS")) +
      " " +
      theme.italic(theme.fg("muted", `v${version}`));
    ctx.ui.setWidget(SPLASH_ID, [
      title,
      ...shortcuts.map(
        ([k, d, muted]) => renderKey(k, muted) + theme.fg("dim", d)
      ),
    ]);
    splashShown = true;
  });

  const clearSplash = (ctx: ExtensionContext) => {
    if (splashShown) {
      ctx.ui.setWidget(SPLASH_ID, undefined);
      splashShown = false;
    }
  };

  pi.on("input", (_event, ctx) => {
    clearSplash(ctx);
    return { action: "continue" };
  });
  pi.on("user_bash", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("session_before_fork", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("session_before_tree", (_event, ctx) => {
    clearSplash(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    clearSplash(ctx);
  });

  pi.registerCommand("clear", {
    description: "Start a new session (alias: /new)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession();
    },
  });

  pi.registerCommand("exit", {
    description: "Exit HDWEBSOFT AGENTS (alias: /quit)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      ctx.shutdown();
    },
  });
}
