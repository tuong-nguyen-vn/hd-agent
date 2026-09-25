import { expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const adapterStarts: unknown[] = [];

mock.module("pi-mcp-adapter", () => ({
  default: (pi: ExtensionAPI) => {
    pi.on("session_start", (event) => {
      adapterStarts.push(event);
    });
  },
}));

const { default: mcpExtension } = await import("./index");

type Handler = (event: unknown, ctx: unknown) => unknown;

// Mirrors pi >= 0.86 dispatch: handlers are snapshotted per emit, so ones
// registered mid-dispatch only see later emits.
function fakePi(): {
  readonly api: ExtensionAPI;
  readonly emit: (type: string, event: unknown) => Promise<void>;
} {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (type: string, handler: Handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      return () => {};
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  const emit = async (type: string, event: unknown): Promise<void> => {
    for (const handler of handlers.get(type)?.slice() ?? []) {
      await handler(event, {});
    }
  };
  return { api, emit };
}

test("replays the adapter's session_start for the session that loaded it", async () => {
  const { api, emit } = fakePi();
  mcpExtension(api);

  const first = { type: "session_start", reason: "startup" };
  await emit("session_start", first);
  expect(adapterStarts).toEqual([first]);

  const second = { type: "session_start", reason: "new" };
  await emit("session_start", second);
  expect(adapterStarts).toEqual([first, second]);
});
