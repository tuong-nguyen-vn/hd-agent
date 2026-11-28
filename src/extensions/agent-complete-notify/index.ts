import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function sendCompletionNotification(count: number): void {
  const title = count === 1 ? "Agent finished" : `Agent finished ${count} runs`;
  // Always ring the terminal bell so tab-aware terminals (Ghostty, iTerm2)
  // mark this tab; the Herdr toast is an additional, host-level signal.
  process.stdout.write("\x07");
  if (process.env["HERDR_ENV"] === "1" && process.env["HERDR_BIN_PATH"]) {
    const command = [
      process.env["HERDR_BIN_PATH"],
      "notification",
      "show",
      title,
      "--sound",
      "done",
    ];
    void Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  }
}

let notifyImpl: (count: number) => void = sendCompletionNotification;

export function setNotifyForTests(
  impl: ((count: number) => void) | undefined
): void {
  notifyImpl = impl ?? sendCompletionNotification;
}

export function resetForTests(): void {
  notifyImpl = sendCompletionNotification;
}

const TITLE_MARKER = "⚡";

function setMarkedTitle(ctx: ExtensionContext, count: number): void {
  const cwd = ctx.cwd.split("/").pop() ?? "";
  const session = ctx.sessionManager.getSessionName();
  const base = session ? `pi - ${session} - ${cwd}` : `pi - ${cwd}`;
  const badge = count > 1 ? `${TITLE_MARKER}${count}` : TITLE_MARKER;
  ctx.ui.setTitle(`${badge} ${base}`);
}

function restoreTitle(ctx: ExtensionContext): void {
  const cwd = ctx.cwd.split("/").pop() ?? "";
  const session = ctx.sessionManager.getSessionName();
  ctx.ui.setTitle(session ? `pi - ${session} - ${cwd}` : `pi - ${cwd}`);
}

export default function (pi: ExtensionAPI): void {
  let agentStartedAt = 0;
  let lastInputAt = 0;
  let unseenCount = 0;

  pi.on("session_start", (_event, ctx) => {
    agentStartedAt = 0;
    unseenCount = 0;
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.onTerminalInput(() => {
      lastInputAt = Date.now();
      if (unseenCount > 0) {
        unseenCount = 0;
        restoreTitle(ctx);
      }
      return undefined;
    });
  });

  pi.on("agent_start", () => {
    agentStartedAt = Date.now();
  });

  pi.on("agent_end", (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI || agentStartedAt === 0) {
      return;
    }
    // No terminal input since the run started → the user is most likely on
    // another tab/window, the exact situation Devin-style notifications cover.
    if (lastInputAt < agentStartedAt) {
      unseenCount += 1;
      notifyImpl(unseenCount);
      setMarkedTitle(ctx, unseenCount);
    }
    agentStartedAt = 0;
  });
}
