import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const unreadBySession = new Map<string, number>();
let activeSession: string | undefined;

type Notify = (
  pi: ExtensionAPI,
  session: string | undefined,
  jobId: string,
  count: number
) => void;

export function markSessionActive(session: string | undefined): void {
  activeSession = session;
  if (session) {
    unreadBySession.delete(session);
  }
}

let notificationSender = sendNotification;

export function setCompletionNotifierForTests(
  notify: Notify | undefined
): void {
  notificationSender = notify ?? sendNotification;
}

export function notifyBackgroundCompletion(
  pi: ExtensionAPI,
  session: string | undefined,
  jobId: string
): void {
  if (session && session === activeSession) {
    return;
  }
  const count = session ? (unreadBySession.get(session) ?? 0) + 1 : 1;
  if (session) {
    unreadBySession.set(session, count);
  }
  notificationSender(pi, session, jobId, count);
}

function sendNotification(
  _pi: ExtensionAPI,
  _session: string | undefined,
  jobId: string,
  count: number
): void {
  const title =
    count === 1 ? "Agent task finished" : `${count} agent tasks finished`;
  process.stdout.write("\x07");
  if (process.env["HERDR_ENV"] === "1" && process.env["HERDR_BIN_PATH"]) {
    const command = [
      process.env["HERDR_BIN_PATH"],
      "notification",
      "show",
      title,
      "--body",
      `Completed ${jobId}; ${count} unread completion${count === 1 ? "" : "s"}`,
      "--sound",
      "done",
    ];
    void Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  }
}

export function resetNotificationsForTests(): void {
  unreadBySession.clear();
  activeSession = undefined;
  notificationSender = sendNotification;
}
