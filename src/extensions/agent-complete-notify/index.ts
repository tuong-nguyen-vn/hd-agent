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
const METADATA_SOURCE = "user:pi-completion-marker";

function herdrBin(): string | undefined {
  return process.env["HERDR_ENV"] === "1"
    ? process.env["HERDR_BIN_PATH"]
    : undefined;
}

function spawnHerdr(args: string[]): void {
  const bin = herdrBin();
  if (bin) {
    void Bun.spawn([bin, ...args], { stdout: "ignore", stderr: "ignore" });
  }
}

function setMarkedTitle(ctx: ExtensionContext, count: number): void {
  // Pane-local OSC titles stop at the multiplexer for unfocused tabs, so the
  // attention marker goes through Herdr's display-only metadata instead,
  // which rolls up to the tab bar. Outside Herdr there is no tab surface to
  // write to; the bell is the only attention signal there.
  const pane = process.env["HERDR_PANE_ID"];
  if (!herdrBin() || !pane) {
    return;
  }
  const badge = count > 1 ? `${TITLE_MARKER}${count}` : TITLE_MARKER;
  spawnHerdr([
    "pane",
    "report-metadata",
    pane,
    "--source",
    METADATA_SOURCE,
    "--agent",
    "pi",
    "--title",
    `${badge} ${ctx.sessionManager.getSessionName() ?? ctx.cwd.split("/").pop() ?? "agent"}`,
  ]);
}

function restoreTitle(): void {
  const pane = process.env["HERDR_PANE_ID"];
  if (!herdrBin() || !pane) {
    return;
  }
  spawnHerdr([
    "pane",
    "report-metadata",
    pane,
    "--source",
    METADATA_SOURCE,
    "--agent",
    "pi",
    "--clear-title",
  ]);
}

export default function (pi: ExtensionAPI): void {
  let running = false;
  let inputDuringRun = false;
  let unseenCount = 0;

  pi.on("session_start", (_event, ctx) => {
    running = false;
    unseenCount = 0;
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.onTerminalInput(() => {
      if (running) {
        inputDuringRun = true;
      }
      if (unseenCount > 0) {
        unseenCount = 0;
        restoreTitle();
      }
      return undefined;
    });
  });

  pi.on("agent_start", () => {
    running = true;
    inputDuringRun = false;
  });

  pi.on("agent_end", (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI || !running) {
      return;
    }
    running = false;
    // No terminal input since the run started → the user is most likely on
    // another tab/window, the exact situation Devin-style notifications cover.
    if (!inputDuringRun) {
      unseenCount += 1;
      notifyImpl(unseenCount);
      setMarkedTitle(ctx, unseenCount);
    }
  });
}
