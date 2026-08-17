import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import registerSubagent from "./index";
import { subagentSchema } from "./schema";

function validate(args: unknown): void {
  validateToolArguments(
    { name: "subagent", parameters: subagentSchema } as never,
    {
      type: "toolCall",
      id: "1",
      name: "subagent",
      arguments: args as Record<string, unknown>,
    }
  );
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
