import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents";
import {
  applyOutputCap,
  childToolNames,
  resolveSubagentModel,
  resolveSubagentModelCandidates,
  runSubagent,
  SubagentEventCapture,
  type SubagentSession,
} from "./subagent";

type UsageOverrides = Omit<Partial<Usage>, "cost"> & {
  readonly cost?: Partial<Usage["cost"]>;
};

const usage = (overrides: UsageOverrides = {}): Usage => {
  const { cost, ...rest } = overrides;
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      ...cost,
    },
    ...rest,
  };
};

function assistant(
  textParts: readonly string[],
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  return {
    role: "assistant",
    content: textParts.map((text) => ({ type: "text", text })),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

const ctx = { cwd: "/work" } as ExtensionContext;

class FakeSession implements SubagentSession {
  public promptCalls = 0;
  public abortCalls = 0;
  public disposeCalls = 0;
  private listener: ((event: never) => void) | undefined;

  public constructor(
    private readonly onPrompt: (
      session: FakeSession,
      prompt: string
    ) => Promise<void>
  ) {}

  public subscribe(listener: (event: never) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public emit(event: unknown): void {
    this.listener?.(event as never);
  }

  public async prompt(prompt: string): Promise<void> {
    this.promptCalls += 1;
    await this.onPrompt(this, prompt);
  }

  public async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

// A FakeSession whose prompt() never resolves on its own, simulating a
// hung nested session (e.g. blocked on network I/O during setup). abort()
// unblocks the pending prompt, matching how a real session's abort tears
// down an in-flight run.
class StuckSession extends FakeSession {
  private finishPrompt: (() => void) | undefined;

  public constructor() {
    super(
      (session) =>
        new Promise<void>((resolve) => {
          (session as StuckSession).finishPrompt = resolve;
        })
    );
  }

  public override async abort(): Promise<void> {
    await super.abort();
    this.finishPrompt?.();
  }
}

describe("childToolNames", () => {
  test("removes the subagent tool from a child's inherited allowlist", () => {
    expect(childToolNames(["read", "subagent", "bash"])).toEqual([
      "read",
      "bash",
    ]);
  });
});

describe("resolveSubagentModel", () => {
  const parentModel = {
    provider: "anthropic",
    id: "parent-model",
    contextWindow: 200_000,
  } as never;
  const configuredModel = {
    provider: "google",
    id: "gemini-flash",
    contextWindow: 1_000_000,
  } as never;
  const modelCtx = {
    model: parentModel,
    modelRegistry: { getAll: () => [parentModel, configuredModel] },
  } as unknown as ExtensionContext;

  test("plain subagents inherit the parent's current model", () => {
    expect(resolveSubagentModel(modelCtx, undefined)).toBe(parentModel);
  });

  test("named agents can select a configured provider/model", () => {
    expect(
      resolveSubagentModel(modelCtx, {
        name: "scout",
        description: "Scout",
        tools: undefined,
        model: "google/gemini-flash",
        systemPrompt: "Scout the codebase.",
        source: "project",
      })
    ).toBe(configuredModel);
  });

  test("unknown configured models fail instead of silently falling back", () => {
    expect(() =>
      resolveSubagentModel(modelCtx, {
        name: "scout",
        description: "Scout",
        tools: undefined,
        model: "missing-model",
        systemPrompt: "Scout the codebase.",
        source: "project",
      })
    ).toThrow('Unknown model "missing-model"');
  });

  test("a bare model id shared by multiple providers yields every authenticated candidate, current provider first", () => {
    const proxyFlash = { provider: "proxy", id: "flash" } as never;
    const devinFlash = { provider: "devin", id: "flash" } as never;
    const unauthedFlash = { provider: "other", id: "flash" } as never;
    const authedProviders = new Set(["proxy", "devin"]);
    const ctx2 = {
      model: { provider: "devin", id: "parent-model" } as never,
      modelRegistry: {
        getAll: () => [proxyFlash, devinFlash, unauthedFlash],
        hasConfiguredAuth: (m: { provider: string }) =>
          authedProviders.has(m.provider),
      },
    } as unknown as ExtensionContext;

    const candidates = resolveSubagentModelCandidates(ctx2, {
      name: "Search",
      description: "Search",
      tools: undefined,
      model: "flash",
      systemPrompt: "",
      source: "bundled",
    });

    expect(candidates).toEqual([devinFlash, proxyFlash]);
  });

  test("comma-separated model list is tried in the declared order", () => {
    const geminiFlash = { provider: "proxy", id: "gemini-3.6-flash" } as never;
    const swe = { provider: "devin", id: "swe-1-7" } as never;
    const ctx2 = {
      model: { provider: "proxy", id: "parent-model" } as never,
      modelRegistry: {
        getAll: () => [geminiFlash, swe],
        hasConfiguredAuth: () => true,
      },
    } as unknown as ExtensionContext;

    const candidates = resolveSubagentModelCandidates(ctx2, {
      name: "Search",
      description: "Search",
      tools: undefined,
      model: "gemini-3.6-flash, swe-1-7",
      systemPrompt: "",
      source: "bundled",
    });

    expect(candidates).toEqual([geminiFlash, swe]);
  });
});

describe("SubagentEventCapture", () => {
  test("concatenates multi-part text, resets for each assistant message, and records usage/tools", () => {
    const updates: string[] = [];
    const capture = new SubagentEventCapture((partial) => {
      updates.push(
        partial.content[0]?.type === "text" ? partial.content[0].text : ""
      );
    });

    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_end",
      message: assistant(["first ", "turn"], {
        usage: usage({ input: 10, output: 4, cost: { total: 0.01 } }),
      }),
    } as never);
    capture.handle({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "read",
      result: {},
      isError: false,
    } as never);
    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_end",
      message: assistant(["final", " answer"], {
        usage: usage({
          input: 2,
          output: 8,
          cacheRead: 3,
          cost: { total: 0.02 },
        }),
      }),
    } as never);

    const snapshot = capture.snapshot();
    expect(snapshot.finalOutput).toBe("final answer");
    expect(snapshot.usage).toEqual({
      input: 12,
      output: 12,
      cacheRead: 3,
      cacheWrite: 0,
      cost: 0.03,
      turns: 2,
      contextTokens: undefined,
    });
    expect(snapshot.toolCalls).toEqual([
      { name: "read", title: "", isError: false },
    ]);
    expect(snapshot.lastToolName).toBe("read");
    expect(updates.at(-1)).toBe("$0.03 ⬝ ?/? ⬝ claude-test ⬝ 2 turns ⬝ 1 tool");
  });

  test("a later message with no text discards the prior message's text", () => {
    const capture = new SubagentEventCapture();

    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_end",
      message: assistant(["intro"], { stopReason: "toolUse" }),
    } as never);
    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_end",
      message: assistant([], { stopReason: "stop" }),
    } as never);

    expect(capture.snapshot().finalOutput).toBe("");
  });

  test("message_update content is materialized lazily on snapshot read", () => {
    const capture = new SubagentEventCapture();

    capture.handle({ type: "message_start", message: assistant([]) } as never);
    capture.handle({
      type: "message_update",
      message: assistant(["partial"]),
    } as never);

    expect(capture.snapshot().finalOutput).toBe("partial");
  });

  test("tool calls capture a title derived from their args", () => {
    const capture = new SubagentEventCapture();

    capture.handle({
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "glob",
      args: { pattern: "**/package.json" },
    } as never);
    capture.handle({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "glob",
      result: {},
      isError: false,
    } as never);
    capture.handle({
      type: "tool_execution_start",
      toolCallId: "2",
      toolName: "read",
      args: { path: "src/index.ts", start: 1, end: 100 },
    } as never);

    const snapshot = capture.snapshot();
    expect(snapshot.toolCalls).toEqual([
      { name: "glob", title: "**/package.json", isError: false },
    ]);
    expect(snapshot.activeToolCalls).toEqual([
      { name: "read", title: "src/index.ts @1-100" },
    ]);
  });
});

describe("applyOutputCap", () => {
  test("truncates on a UTF-8 boundary and reports omitted bytes", () => {
    const capped = applyOutputCap("😀😀😀", 5);

    expect(capped.text).toContain(
      "😀\n[subagent: output truncated, 8 bytes omitted"
    );
    expect(capped.text).not.toContain("�");
    expect(capped.truncated).toBe(true);
    expect(capped.omittedBytes).toBe(8);
  });
});

describe("runSubagent", () => {
  test("returns bare text on normal completion", async () => {
    const fake = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({
        type: "message_end",
        message: assistant(["hello"]),
      });
    });

    const result = await runSubagent(
      "say hi",
      ctx,
      undefined,
      undefined,
      async () => fake
    );

    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.details.fullOutput).toBe("hello");
    expect(fake.promptCalls).toBe(1);
    expect(fake.abortCalls).toBe(0);
    expect(fake.disposeCalls).toBe(1);
  });

  test("returns a hint, not an error, for normal empty output", async () => {
    const fake = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({ type: "message_end", message: assistant([]) });
    });

    const result = await runSubagent(
      "empty",
      ctx,
      undefined,
      undefined,
      async () => fake
    );

    expect(
      result.content[0]?.type === "text" ? result.content[0].text : ""
    ).toBe("[subagent tool: completed with no text output.]");
  });

  test("throws on model error with partial output", async () => {
    const fake = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({
        type: "message_end",
        message: assistant(["partial"], {
          stopReason: "error",
          errorMessage: "provider exploded",
        }),
      });
    });

    await expect(
      runSubagent("fail", ctx, undefined, undefined, async () => fake)
    ).rejects.toThrow(
      "Subagent failed: error. Error: provider exploded.\nPartial output before failure:\npartial"
    );
  });

  test("rejects pre-aborted signals before prompt", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeSession(async () => {});

    await expect(
      runSubagent("abort", ctx, controller.signal, undefined, async () => fake)
    ).rejects.toThrow("Subagent failed: subagent aborted before start");

    expect(fake.promptCalls).toBe(0);
    expect(fake.abortCalls).toBe(0);
    expect(fake.disposeCalls).toBe(0);
  });

  test("mid-run abort aborts once, tears down, and rejects", async () => {
    let finishPrompt: (() => void) | undefined;
    const fake = new (class extends FakeSession {
      public override async abort(): Promise<void> {
        await super.abort();
        finishPrompt?.();
      }
    })(
      () =>
        new Promise<void>((resolve) => {
          finishPrompt = resolve;
        })
    );
    const controller = new AbortController();
    const promise = runSubagent(
      "long",
      ctx,
      controller.signal,
      undefined,
      async () => fake
    );

    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toThrow("Subagent failed: aborted");
    expect(fake.promptCalls).toBe(1);
    expect(fake.abortCalls).toBe(1);
    expect(fake.disposeCalls).toBe(1);
  });

  test("a stalled attempt (no progress) aborts, tears down, and rejects without hanging", async () => {
    const fake = new StuckSession();

    await expect(
      runSubagent(
        "stuck",
        ctx,
        undefined,
        undefined,
        async () => fake,
        undefined,
        undefined,
        5
      )
    ).rejects.toThrow("Subagent failed: stalled");

    expect(fake.abortCalls).toBe(1);
    expect(fake.disposeCalls).toBe(1);
  });

  test("nested subagent calls are rejected by the async-local recursion ban", async () => {
    const outer = new FakeSession(async () => {
      const inner = new FakeSession(async () => {});
      await runSubagent("inner", ctx, undefined, undefined, async () => inner);
    });

    await expect(
      runSubagent("outer", ctx, undefined, undefined, async () => outer)
    ).rejects.toThrow("subagents cannot call subagent tool");
  });
});

describe("runSubagent with a named agent", () => {
  const originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
  let root: string;
  let projectCtx: ExtensionContext;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pim-subagent-run-"));
    process.env["PI_CODING_AGENT_DIR"] = join(root, "empty-user-agent-dir");
    const agentsDir = join(root, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Reviews code",
        "tools: read, grep",
        "---",
        "You are a meticulous code reviewer.",
      ].join("\n"),
      "utf-8"
    );
    await writeFile(
      join(agentsDir, "multimodel.md"),
      [
        "---",
        "name: multimodel",
        "description: Tries two models",
        "model: proxy/a, proxy/b",
        "---",
        "Body.",
      ].join("\n"),
      "utf-8"
    );
    projectCtx = {
      cwd: root,
      modelRegistry: {
        getAll: () => [
          { provider: "proxy", id: "a" },
          { provider: "proxy", id: "b" },
        ],
        hasConfiguredAuth: () => true,
      },
    } as unknown as ExtensionContext;
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("uses the named agent config and sends only the task as the user prompt", async () => {
    let receivedAgent: AgentConfig | undefined;
    let receivedPrompt: string | undefined;
    const fake = new FakeSession(async (session, prompt) => {
      receivedPrompt = prompt;
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({ type: "message_end", message: assistant(["done"]) });
    });

    const result = await runSubagent(
      "find bugs",
      projectCtx,
      undefined,
      undefined,
      async (_parentCtx, _activeToolNames, agent) => {
        receivedAgent = agent;
        return fake;
      },
      ["read", "bash", "subagent"],
      "reviewer"
    );

    expect(receivedAgent).toEqual({
      name: "reviewer",
      description: "Reviews code",
      tools: ["read", "grep"],
      model: undefined,
      systemPrompt: "You are a meticulous code reviewer.",
      source: "project",
    });
    expect(receivedPrompt).toBe("Task: find bugs");
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
  });

  test("throws with the list of available agents for an unknown name", async () => {
    const fake = new FakeSession(async () => {});

    const result = runSubagent(
      "task",
      projectCtx,
      undefined,
      undefined,
      async () => fake,
      undefined,
      "nonexistent"
    );

    await expect(result).rejects.toThrow(
      'Unknown subagent "nonexistent". Available:'
    );
    await expect(result).rejects.toThrow("Search (bundled)");
    await expect(result).rejects.toThrow("Oracle (bundled)");
    await expect(result).rejects.toThrow("reviewer (project)");
    expect(fake.promptCalls).toBe(0);
  });

  test("resolves configured agent names case-insensitively", async () => {
    let receivedAgent: AgentConfig | undefined;
    const fake = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({ type: "message_end", message: assistant(["done"]) });
    });

    await runSubagent(
      "find exports",
      projectCtx,
      undefined,
      undefined,
      async (_parentCtx, _activeToolNames, agent) => {
        receivedAgent = agent;
        return fake;
      },
      undefined,
      "REVIEWER"
    );

    expect(receivedAgent?.name).toBe("reviewer");
  });

  test("a stalled attempt falls back to the next configured model candidate", async () => {
    const stuck = new StuckSession();
    const healthy = new FakeSession(async (session) => {
      session.emit({ type: "message_start", message: assistant([]) });
      session.emit({ type: "message_end", message: assistant(["recovered"]) });
    });
    const sessions = [stuck, healthy];

    const result = await runSubagent(
      "find bugs",
      projectCtx,
      undefined,
      undefined,
      async () => sessions.shift() as FakeSession,
      undefined,
      "multimodel",
      5
    );

    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(stuck.abortCalls).toBe(1);
    expect(healthy.abortCalls).toBe(0);
  });
});
