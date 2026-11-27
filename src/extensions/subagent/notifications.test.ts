import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  markSessionActive,
  notifyBackgroundCompletion,
  resetNotificationsForTests,
  setCompletionNotifierForTests,
} from "./notifications";

afterEach(resetNotificationsForTests);

test("does not notify when completion belongs to the active session", () => {
  const notifications: unknown[][] = [];
  setCompletionNotifierForTests((...args) => {
    notifications.push(args);
  });
  markSessionActive("chat-a");
  notifyBackgroundCompletion({} as ExtensionAPI, "chat-a", "subagent-1");
  expect(notifications).toHaveLength(0);
});

test("notifies once and adds a count for multiple unread completions", () => {
  const notifications: unknown[][] = [];
  setCompletionNotifierForTests((...args) => {
    notifications.push(args);
  });
  notifyBackgroundCompletion({} as ExtensionAPI, "chat-a", "subagent-1");
  notifyBackgroundCompletion({} as ExtensionAPI, "chat-a", "subagent-2");
  expect(notifications.map((args) => args[3])).toEqual([1, 2]);
});

test("clears only the session that becomes active", () => {
  const notifications: unknown[][] = [];
  setCompletionNotifierForTests((...args) => {
    notifications.push(args);
  });
  notifyBackgroundCompletion({} as ExtensionAPI, "chat-a", "subagent-1");
  notifyBackgroundCompletion({} as ExtensionAPI, "chat-b", "subagent-2");
  markSessionActive("chat-a");
  notifyBackgroundCompletion({} as ExtensionAPI, "chat-b", "subagent-3");
  notifyBackgroundCompletion({} as ExtensionAPI, "chat-a", "subagent-4");
  expect(notifications.map((args) => args[3])).toEqual([1, 1, 2]);
});
