import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalIndexer } from "./indexer";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "journal-test-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function sessionEntry(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

function sessionFile(dir: string, name: string, lines: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.map(sessionEntry).join(""));
  return path;
}

function userPrompt(id: string, text: string, ts = "2026-11-28T10:00:00Z") {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function indexer(): JournalIndexer {
  return new JournalIndexer(join(work, "index.db"), join(work, "sessions"));
}

describe("JournalIndexer", () => {
  test("extracts human user prompts from a session file", async () => {
    sessionFile(join(work, "sessions", "--proj--"), "s1.jsonl", [
      { type: "session", id: "x", timestamp: "t", cwd: "/proj" },
      userPrompt("u1", "làm widget kiểm tra thu nhập"),
      {
        type: "custom_message",
        customType: "bash-job",
        content: "Background job completed",
      },
      userPrompt("u2", "đọc code và tóm tắt"),
    ]);
    const idx = indexer();
    const { indexed } = await idx.indexSessions();
    expect(indexed).toBe(2);
    const results = idx.search("widget");
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe("làm widget kiểm tra thu nhập");
    expect(results[0]?.cwd).toBe("/proj");
    idx.close();
  });

  test("dedupes re-scanned entries and reads only appended tails", async () => {
    const dir = join(work, "sessions", "--proj--");
    const file = sessionFile(dir, "s1.jsonl", [
      { type: "session", id: "x", timestamp: "t", cwd: "/proj" },
      userPrompt("u1", "first prompt"),
    ]);
    const idx = indexer();
    await idx.indexSessions();
    const again = await idx.indexSessions();
    expect(again.indexed).toBe(0);
    appendFileSync(file, sessionEntry(userPrompt("u2", "second prompt")));
    const after = await idx.indexSessions();
    expect(after.indexed).toBe(1);
    expect(idx.search("second")).toHaveLength(1);
    idx.close();
  });

  test("tolerates a partial trailing line from a concurrent writer", async () => {
    const dir = join(work, "sessions", "--proj--");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s1.jsonl");
    const good =
      sessionEntry({ type: "session", id: "x", timestamp: "t", cwd: "/p" }) +
      sessionEntry(userPrompt("u1", "complete prompt"));
    writeFileSync(file, good + '{"type":"message","id":"u2","mess');
    const idx = indexer();
    const { indexed } = await idx.indexSessions();
    expect(indexed).toBe(1);
    // Complete the partial line, simulating the writer finishing it.
    appendFileSync(
      file,
      'age":{"role":"user","content":[{"type":"text","text":"completed later"}]}}\n'
    );
    const second = await idx.indexSessions();
    expect(second.indexed).toBe(1);
    expect(idx.search("completed")).toHaveLength(1);
    idx.close();
  });

  test("returns no results for an empty or missing sessions dir", async () => {
    const idx = indexer();
    const { indexed } = await idx.indexSessions();
    expect(indexed).toBe(0);
    expect(idx.search("anything")).toHaveLength(0);
    idx.close();
  });

  test("ranks current-project prompts first across projects", async () => {
    sessionFile(join(work, "sessions", "--projA--"), "a.jsonl", [
      { type: "session", id: "x", timestamp: "t", cwd: "/projA" },
      userPrompt("u1", "shared keyword alpha", "2026-11-28T10:00:00Z"),
    ]);
    sessionFile(join(work, "sessions", "--projB--"), "b.jsonl", [
      { type: "session", id: "y", timestamp: "t", cwd: "/projB" },
      userPrompt("u2", "shared keyword beta", "2026-11-28T11:00:00Z"),
    ]);
    const idx = indexer();
    await idx.indexSessions();
    const results = idx.search("shared keyword", 10, "/projA");
    expect(results).toHaveLength(2);
    expect(results[0]?.cwd).toBe("/projA");
    idx.close();
  });

  test("multi-byte UTF-8 prompts do not corrupt tail offsets", async () => {
    const dir = join(work, "sessions", "--proj--");
    const file = sessionFile(dir, "s1.jsonl", [
      { type: "session", id: "x", timestamp: "t", cwd: "/proj" },
      userPrompt("u1", "kiểm tra thu nhập và chi tiêu gia đình"),
    ]);
    const idx = indexer();
    await idx.indexSessions();
    appendFileSync(
      file,
      sessionEntry(userPrompt("u2", "đọc lại bảng lương tháng mười một"))
    );
    const after = await idx.indexSessions();
    expect(after.indexed).toBe(1);
    expect(idx.search("lương")).toHaveLength(1);
    expect(idx.search("lương")[0]?.text).toBe(
      "đọc lại bảng lương tháng mười một"
    );
    idx.close();
  });

  test("skips non-user and empty-text messages", async () => {
    sessionFile(join(work, "sessions", "--proj--"), "s1.jsonl", [
      { type: "session", id: "x", timestamp: "t", cwd: "/proj" },
      {
        type: "message",
        id: "a1",
        timestamp: "t",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "reply" }],
        },
      },
      {
        type: "message",
        id: "u1",
        timestamp: "t",
        message: { role: "user", content: [{ type: "image", source: "x" }] },
      },
      userPrompt("u2", "real prompt"),
    ]);
    const idx = indexer();
    const { indexed } = await idx.indexSessions();
    expect(indexed).toBe(1);
    idx.close();
  });
});
