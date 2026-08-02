import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SPLASH_ID = "pim-splash";

function isAbortError(reason: unknown): boolean {
  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return reason.name === "AbortError";
  }
  return reason instanceof Error && reason.name === "AbortError";
}

// Pressing Escape aborts the active tool/stream signal. Some cancellable work
// (fetch, worker requests, subagent sessions) only surfaces that as a
// rejected promise after the synchronous abort() call has already returned,
// once nothing is left to await it. Swallow only AbortError here so
// cancellation is a no-op from the user's perspective; anything else is
// logged (not hidden) instead of taking down the session.
process.on("unhandledRejection", (reason) => {
  if (isAbortError(reason)) {
    return;
  }
  console.error("pim: unhandled rejection:", reason);
});

// pi's own AbortController.abort() call (e.g. restoreQueuedMessagesToEditor
// on Escape) dispatches to any synchronous "abort" listeners still attached
// to the active run's signal (streaming readers, etc). If one of those
// throws, it bubbles up *synchronously* through abort() itself, out of the
// keystroke handler - pressing Escape while the model is actively
// streaming/thinking hits this path. pi registers its own uncaughtException
// handler via prependListener during startup (restores the terminal, then
// unconditionally calls process.exit(1)), which runs *before* any handler an
// extension adds with plain `.on()` - so a normal listener here would never
// get a chance to run. Extensions load after that registration, so
// prependListener here puts this handler in front instead, letting it
// swallow AbortError before pi's handler can kill the process. Anything else
// is left alone (not exited here) - Node keeps invoking the remaining
// uncaughtException listeners in order, so pi's own handler still runs
// after this one and restores the terminal / exits as designed.
process.prependListener("uncaughtException", (error) => {
  if (isAbortError(error)) {
    return;
  }
  console.error("pim: uncaught exception:", error);
});

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
      "Pim requires the Bun runtime.\n" +
        "Install the Pim launcher: bun install -g @aaroncql/pim-agent\n" +
        "Then run: amp-pi (or hd-agent)\n" +
        "If amp-pi cannot locate Pi, ensure `pi` is on PATH or set PIM_PI_CLI=/path/to/cli.js"
    );
  }

  const pkgPath = `${import.meta.dir}/../../../package.json`;
  const { version } = (await Bun.file(pkgPath).json()) as { version: string };

  const keyCol = Math.max(...shortcuts.map(([k]) => k.length)) + 2;

  let splashShown = false;

  pi.on("session_start", (event, ctx) => {
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
