import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const unreadBySession = new Map<string, number>();

type Notify = (pi: ExtensionAPI, count: number) => void;

let notificationSender = sendNotification;

export function setCompletionNotifierForTests(
  notify: Notify | undefined
): void {
  notificationSender = notify ?? sendNotification;
}

export function markSessionActive(sessionFile: string | undefined): void {
  if (sessionFile) {
    unreadBySession.delete(sessionFile);
  }
}

export function notifyAgentCompletion(
  pi: ExtensionAPI,
  sessionFile: string | undefined
): void {
  const count = sessionFile ? (unreadBySession.get(sessionFile) ?? 0) + 1 : 1;
  if (sessionFile) {
    unreadBySession.set(sessionFile, count);
  }
  notificationSender(pi, count);
}

function sendNotification(_pi: ExtensionAPI, count: number): void {
  const title = count === 1 ? "Agent finished" : `${count} agent runs finished`;
  if (process.env["HERDR_ENV"] === "1" && process.env["HERDR_BIN_PATH"]) {
    const command = [
      process.env["HERDR_BIN_PATH"],
      "notification",
      "show",
      title,
      "--body",
      `${count} unread completion${count === 1 ? "" : "s"}`,
      "--sound",
      "done",
    ];
    void Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    return;
  }
  process.stdout.write("\x07");
}

export function resetNotificationsForTests(): void {
  unreadBySession.clear();
  notificationSender = sendNotification;
}
