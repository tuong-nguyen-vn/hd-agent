import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  markSessionActive,
  notifyAgentCompletion,
  resetNotificationsForTests,
  setCompletionNotifierForTests,
} from "./notifications";

afterEach(resetNotificationsForTests);

test("main agent completion sends one notification with count one", () => {
  const notifications: number[] = [];
  setCompletionNotifierForTests((_pi, count) => {
    notifications.push(count);
  });
  notifyAgentCompletion({} as ExtensionAPI, "chat-a");
  expect(notifications).toEqual([1]);
});

test("multiple main-agent completions accumulate per session", () => {
  const notifications: number[] = [];
  setCompletionNotifierForTests((_pi, count) => {
    notifications.push(count);
  });
  notifyAgentCompletion({} as ExtensionAPI, "chat-a");
  notifyAgentCompletion({} as ExtensionAPI, "chat-a");
  notifyAgentCompletion({} as ExtensionAPI, "chat-b");
  expect(notifications).toEqual([1, 2, 1]);
});

test("returning to a chat clears its unread count", () => {
  const notifications: number[] = [];
  setCompletionNotifierForTests((_pi, count) => {
    notifications.push(count);
  });
  notifyAgentCompletion({} as ExtensionAPI, "chat-a");
  notifyAgentCompletion({} as ExtensionAPI, "chat-a");
  markSessionActive("chat-a");
  notifyAgentCompletion({} as ExtensionAPI, "chat-a");
  expect(notifications).toEqual([1, 2, 1]);
});
