import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalLine } from "../../shared/JournalLine";
import registerJournal from "./index";
import { isMemoryEnabled, setMemoryEnabled } from "./state";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "journal-wiring-"));
  process.env["HD_MEMORY_STATE_PATH"] = join(work, "state.json");
  process.env["HD_MEMORY_INDEX_DB"] = join(work, "index.db");
  process.env["HD_MEMORY_SESSIONS_ROOT"] = join(work, "sessions");
  setMemoryEnabled(true);
});

afterEach(() => {
  JournalLine.resetForTests();
  delete process.env["HD_MEMORY_STATE_PATH"];
  delete process.env["HD_MEMORY_INDEX_DB"];
  delete process.env["HD_MEMORY_SESSIONS_ROOT"];
  if (work) {
    rmSync(work, { recursive: true, force: true });
  }
});

type Handler = (event: never, ctx: ExtensionContext) => void;

type Harness = {
  readonly handlers: Map<string, Handler>;
  readonly commands: Map<string, { handler: Function }>;
  readonly tools: Map<string, { execute: Function }>;
  readonly messages: Array<{ customType: string; content: string }>;
  readonly ctx: ExtensionContext;
  emit(event: string, data?: unknown): void;
};

function harness(): Harness {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Function }>();
  const tools = new Map<string, { execute: Function }>();
  const messages: Array<{ customType: string; content: string }> = [];

  const ctx = {
    cwd: "/work",
    hasUI: true,
    ui: {
      notify: (): void => {},
      setWidget: (): void => {},
    },
  } as unknown as ExtensionContext;

  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    },
    registerCommand(name: string, def: { handler: Function }): void {
      commands.set(name, def);
    },
    registerTool(def: { name: string; execute: Function }): void {
      tools.set(def.name, def);
    },
    sendMessage(message: { customType: string; content: string }): void {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;

  registerJournal(pi);

  return {
    handlers,
    commands,
    tools,
    messages,
    ctx,
    emit(event: string, data?: unknown): void {
      handlers.get(event)?.(data as never, ctx);
    },
  };
}

function seedSession(root: string, prompts: string[]): void {
  const dir = join(root, "sessions", "--work--");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", id: "s", timestamp: "t", cwd: "/work" }),
    ...prompts.map((text, i) =>
      JSON.stringify({
        type: "message",
        id: `u${i}`,
        parentId: null,
        timestamp: `2026-11-28T1${i}:00:00Z`,
        message: { role: "user", content: [{ type: "text", text }] },
      })
    ),
  ];
  writeFileSync(join(dir, "seed.jsonl"), `${lines.join("\n")}\n`);
}

describe("journal wiring", () => {
  test("registers the journal_search tool and /memory command", () => {
    const h = harness();
    expect(h.tools.has("journal_search")).toBe(true);
    expect(h.commands.has("memory")).toBe(true);
  });

  test("shows the memory indicator on session start", () => {
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(JournalLine.getText()).toBe("mem");
  });

  test("hides indicator state correctly when memory is off", () => {
    setMemoryEnabled(false);
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(JournalLine.getText()).toBe("mem off");
  });

  test("/memory toggles indexing state", async () => {
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(isMemoryEnabled()).toBe(true);
    await h.commands.get("memory")!.handler("", h.ctx);
    expect(isMemoryEnabled()).toBe(false);
    expect(JournalLine.getText()).toBe("mem off");
    await h.commands.get("memory")!.handler("", h.ctx);
    expect(isMemoryEnabled()).toBe(true);
  });

  test("/memory on and off set explicit state", async () => {
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.commands.get("memory")!.handler("off", h.ctx);
    expect(isMemoryEnabled()).toBe(false);
    await h.commands.get("memory")!.handler("on", h.ctx);
    expect(isMemoryEnabled()).toBe(true);
  });

  test("clicking the indicator flips state through JournalLine.toggle", async () => {
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(isMemoryEnabled()).toBe(true);
    JournalLine.toggle();
    await new Promise((r) => setTimeout(r, 10));
    expect(isMemoryEnabled()).toBe(false);
  });

  test("/memory recall sends matching prompts as a chat message", async () => {
    seedSession(work, ["làm widget kiểm tra thu nhập", "đọc code và tóm tắt"]);
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    await new Promise((r) => setTimeout(r, 50));
    await h.commands.get("memory")!.handler("recall widget", h.ctx);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.customType).toBe("journal-recall");
    expect(h.messages[0]?.content).toContain("widget");
  });

  test("/memory recall with empty query shows usage", async () => {
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.commands.get("memory")!.handler("recall", h.ctx);
    expect(h.messages).toHaveLength(0);
  });

  test("journal_search tool returns formatted results", async () => {
    seedSession(work, ["kiểm tra thu nhập gia đình"]);
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    await new Promise((r) => setTimeout(r, 50));
    const tool = h.tools.get("journal_search");
    const result = await tool!.execute(
      "t1",
      { query: "thu nhập" },
      undefined,
      undefined,
      h.ctx
    );
    const text = result.content[0].text as string;
    expect(text).toContain("thu nhập");
    expect(text).toContain("/work");
  });

  test("journal_search reports no matches on an empty index", async () => {
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    await new Promise((r) => setTimeout(r, 50));
    const tool = h.tools.get("journal_search");
    const result = await tool!.execute(
      "t1",
      { query: "nonexistent" },
      undefined,
      undefined,
      h.ctx
    );
    expect(result.content[0].text).toContain("No matching prompts");
  });

  test("session_shutdown clears the indicator", () => {
    const h = harness();
    h.emit("session_start", { type: "session_start", reason: "startup" });
    h.emit("session_shutdown", { type: "session_shutdown" });
    expect(JournalLine.getText()).toBeUndefined();
  });
});
