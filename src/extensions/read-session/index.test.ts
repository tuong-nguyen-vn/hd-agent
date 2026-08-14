import { expect, test } from "bun:test";
import type {
  ExtensionContext,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { executeReadSession } from "./index";

const info = (id: string, path = `/sessions/${id}.jsonl`): SessionInfo => ({
  id,
  path,
  cwd: "/work",
  created: new Date("2026-01-01T00:00:00Z"),
  modified: new Date("2026-01-02T00:00:00Z"),
  messageCount: 2,
  firstMessage: "old task",
  allMessagesText: "old task done",
});

function context(currentId = "current"): ExtensionContext {
  return {
    cwd: "/work",
    sessionManager: {
      getSessionId: () => currentId,
      getSessionDir: () => "/sessions",
    },
  } as unknown as ExtensionContext;
}

test("executeReadSession resolves an exact workspace session and returns only summary metadata", async () => {
  const result = await executeReadSession(
    { id: "target" },
    context(),
    undefined,
    {
      listSessions: async (cwd, sessionDir) => {
        expect(cwd).toBe("/work");
        expect(sessionDir).toBe("/sessions");
        return [info("target")];
      },
      readSession: async (path, expectedId) => {
        expect(path).toBe("/sessions/target.jsonl");
        expect(expectedId).toBe("target");
        return [{ role: "user", content: "Do the task" }] as never;
      },
      summarize: async (transcript) => {
        expect(transcript).toContain("Do the task");
        return {
          text: "## Goal\nDo the task",
          model: "google/gemini-3.7-flash",
          usedFallback: false,
        };
      },
    }
  );

  expect(result.content[0]?.text).toContain("Goal");
  expect(result.details.sessionId).toBe("target");
  expect(result.details).not.toHaveProperty("path");
  expect(result.details).not.toHaveProperty("transcript");
});

test("executeReadSession rejects the current session and non-workspace IDs", async () => {
  await expect(
    executeReadSession({ id: "current" }, context("current"), undefined, {
      listSessions: async () => {
        throw new Error("should not list");
      },
      readSession: async () => [],
      summarize: async () => {
        throw new Error("should not summarize");
      },
    })
  ).rejects.toThrow("current session");

  await expect(
    executeReadSession({ id: "other-workspace" }, context(), undefined, {
      listSessions: async () => [info("local")],
      readSession: async () => [],
      summarize: async () => {
        throw new Error("should not summarize");
      },
    })
  ).rejects.toThrow("not found in the current workspace");
});

test("executeReadSession verifies the opened session header ID", async () => {
  await expect(
    executeReadSession({ id: "target" }, context(), undefined, {
      listSessions: async () => [info("target")],
      readSession: async () => {
        throw new Error(
          'Session "target" could not be verified because its file header has a different ID.'
        );
      },
      summarize: async () => ({
        text: "unused",
        model: "unused",
        usedFallback: false,
      }),
    })
  ).rejects.toThrow("different ID");
});
