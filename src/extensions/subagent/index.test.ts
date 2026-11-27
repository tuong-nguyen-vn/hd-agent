import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import { Jobs } from "../../shared/Jobs";
import registerSubagent, { setRunSubagentForTests } from "./index";
import { setCompletionNotifierForTests } from "./notifications";
import { subagentSchema } from "./schema";
import type { SubagentDetails } from "./subagent";

function validate(args: unknown): void {
  validateToolArguments(
    { name: "subagent", parameters: subagentSchema } as never,
    {
      type: "toolCall",
      id: "1",
      name: "subagent",
      arguments: args as JsonObject,
    }
  );
}

afterEach(() => {
  setRunSubagentForTests(undefined);
  setCompletionNotifierForTests(undefined);
  Jobs.resetForTests();
});

function captureTool(): {
  readonly pi: ExtensionAPI;
  readonly sent: { content: unknown; options: unknown }[];
  tool(): {
    execute: (...args: unknown[]) => Promise<unknown>;
  };
} {
  const sent: { content: unknown; options: unknown }[] = [];
  let tool:
    | {
        execute: (...args: unknown[]) => Promise<unknown>;
      }
    | undefined;
  const pi = {
    on(): void {},
    registerTool(def: unknown) {
      tool = def as typeof tool;
    },
    getActiveTools: () => ["read", "bash"],
    sendMessage(content: unknown, options: unknown): void {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  registerSubagent(pi);
  return {
    pi,
    sent,
    tool() {
      if (!tool) {
        throw new Error("tool not registered");
      }
      return tool;
    },
  };
}

describe("subagent extension registration", () => {
  test("schema rejects an empty prompt", () => {
    expect(() => validate({ prompt: "" })).toThrow();
  });

  test("registers one parallel tool without a prompt snippet", () => {
    let tool:
      | {
          readonly name: string;
          readonly executionMode?: string;
          readonly promptSnippet?: string;
          readonly parameters: unknown;
        }
      | undefined;
    registerSubagent({
      on(): void {},
      registerTool(def: unknown) {
        tool = def as typeof tool;
      },
    } as unknown as ExtensionAPI);

    expect(tool?.name).toBe("subagent");
    expect(tool?.executionMode).toBe("parallel");
    expect(tool?.promptSnippet).toBeUndefined();
    expect(tool?.parameters).toBeDefined();
    const wireProps = (tool!.parameters as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(wireProps).sort()).toEqual([
      "agent",
      "background",
      "context_paths",
      "prompt",
    ]);
    expect(wireProps.prompt).not.toHaveProperty("minLength");
  });

  test("prewarm reads the cwd synchronously and is cancelled on teardown", () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => void
    >();
    registerSubagent({
      on(event: string, handler: (e: unknown, c: ExtensionContext) => void) {
        handlers.set(event, handler);
      },
      registerTool(): void {},
    } as unknown as ExtensionAPI);

    let cwdReads = 0;
    let stale = false;
    const ctx = {
      get cwd(): string {
        cwdReads += 1;
        if (stale) {
          throw new Error("This extension ctx is stale");
        }
        return "/work";
      },
    } as ExtensionContext;

    const scheduled: object[] = [];
    const cleared: object[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((): object => {
      const token = {};
      scheduled.push(token);
      return token;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((token: object): void => {
      cleared.push(token);
    }) as unknown as typeof globalThis.clearTimeout;

    try {
      handlers.get("session_start")!({ reason: "startup" }, ctx);
      expect(cwdReads).toBe(1);
      expect(scheduled).toHaveLength(1);

      // Once the session is replaced or reloaded the ctx throws on every
      // getter, so teardown must drop the pending timer instead of letting it
      // reach for the ctx later.
      stale = true;
      handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
      expect(cleared).toEqual([scheduled[0]!]);
      expect(cwdReads).toBe(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

describe("background subagents", () => {
  const toolCtx = { cwd: "/work" } as ExtensionContext;

  function fakeResult(text: string) {
    return {
      content: [{ type: "text" as const, text }],
      details: {} as SubagentDetails,
    };
  }

  test("returns a job id immediately and notifies on completion", async () => {
    const { sent, tool } = captureTool();
    const notifications: unknown[][] = [];
    setCompletionNotifierForTests((async (...args: unknown[]) => {
      notifications.push(args);
    }) as never);
    let release: ((v: ReturnType<typeof fakeResult>) => void) | undefined;
    const gate = new Promise<ReturnType<typeof fakeResult>>((resolve) => {
      release = resolve;
    });
    setRunSubagentForTests((async () => gate) as never);

    const result = (await tool().execute(
      "call-1",
      { prompt: "research the thing", background: true },
      undefined,
      undefined,
      toolCtx
    )) as { content: { text: string }[]; details: SubagentDetails };

    expect(result.content[0]!.text).toContain("subagent-");
    const job = Jobs.list()[0];
    expect(job?.kind).toBe("subagent");
    expect(job?.status).toBe("running");

    release?.(fakeResult("deep findings"));
    await Bun.sleep(0);
    await Bun.sleep(0);

    const settled = Jobs.get(job!.id);
    expect(settled?.status).toBe("completed");
    expect(settled?.output.text).toBe("deep findings");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toEqual({ triggerTurn: true });
    const msg = sent[0]!.content as { customType: string; content: string };
    expect(msg.customType).toBe("subagent-report");
    expect(msg.content).toContain("deep findings");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![3]).toBe(1);
  });

  test("reports failures through the job and a follow-up message", async () => {
    const { sent, tool } = captureTool();
    setRunSubagentForTests((async () => {
      throw new Error("provider exploded");
    }) as never);

    await tool().execute(
      "call-1",
      { prompt: "doomed task", background: true },
      undefined,
      undefined,
      toolCtx
    );
    await Bun.sleep(0);
    await Bun.sleep(0);

    const job = Jobs.list()[0];
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("provider exploded");
    expect(sent).toHaveLength(1);
  });

  test("jobs kill aborts the background run without a failure report", async () => {
    const { sent, tool } = captureTool();
    let seenSignal: AbortSignal | undefined;
    setRunSubagentForTests(((
      _p: string,
      _c: unknown,
      signal: AbortSignal | undefined
    ) => {
      seenSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }) as never);

    await tool().execute(
      "call-1",
      { prompt: "slow work", background: true },
      undefined,
      undefined,
      toolCtx
    );
    const job = Jobs.list()[0]!;
    expect(Jobs.cancel(job.id)).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(Jobs.get(job.id)?.status).toBe("cancelled");
    // Cancelled jobs are not reported as failed to the parent.
    expect(sent).toHaveLength(0);
  });

  test("completion notifier receives the originating session for each job", async () => {
    const { tool } = captureTool();
    const sessions: string[] = [];
    setCompletionNotifierForTests(((
      _pi: ExtensionAPI,
      sessionFile: string | undefined
    ) => {
      sessions.push(sessionFile ?? "missing");
    }) as never);
    setRunSubagentForTests((async () => fakeResult("done")) as never);

    const ctx = {
      ...toolCtx,
      sessionManager: { getSessionFile: () => "/sessions/chat.jsonl" },
    } as ExtensionContext;
    await tool().execute(
      "call-1",
      { prompt: "first", background: true },
      undefined,
      undefined,
      ctx
    );
    await tool().execute(
      "call-2",
      { prompt: "second", background: true },
      undefined,
      undefined,
      ctx
    );
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(sessions).toEqual(["/sessions/chat.jsonl", "/sessions/chat.jsonl"]);
  });

  test("foreground calls still wait for the result", async () => {
    const { tool } = captureTool();
    setRunSubagentForTests((async () => fakeResult("sync answer")) as never);
    const result = (await tool().execute(
      "call-1",
      { prompt: "direct" },
      undefined,
      undefined,
      toolCtx
    )) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe("sync answer");
    expect(Jobs.list()).toHaveLength(0);
  });
});
