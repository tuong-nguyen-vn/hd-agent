import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import registerNotify, { resetForTests, setNotifyForTests } from "./index";

afterEach(() => {
  resetForTests();
});

type Handler = (event: never, ctx: ExtensionContext) => void;

function harness(): {
  handlers: Map<string, Handler>;
  inputListeners: Array<(data: string) => unknown>;
  ctx: ExtensionContext;
  emit(event: string, data?: unknown): void;
  type(): void;
} {
  const handlers = new Map<string, Handler>();
  const inputListeners: Array<(data: string) => unknown> = [];
  const ctx = {
    cwd: "/work",
    hasUI: true,
    ui: {
      notify: (): void => {},
      setTitle: (): void => {},
      onTerminalInput: (listener: (data: string) => unknown) => {
        inputListeners.push(listener);
        return () => {};
      },
    },
    sessionManager: {
      getSessionName: () => undefined,
    },
  } as unknown as ExtensionContext;

  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    },
    registerCommand(): void {},
  } as unknown as ExtensionAPI;

  registerNotify(pi);

  return {
    handlers,
    inputListeners,
    ctx,
    emit(event: string, data?: unknown): void {
      handlers.get(event)?.(data as never, ctx);
    },
    type(): void {
      for (const l of inputListeners) {
        l("x");
      }
    },
  };
}

describe("agent-complete-notify", () => {
  test("notifies when the agent finishes with no terminal input during the run", () => {
    const calls: number[] = [];
    setNotifyForTests((count) => calls.push(count));
    const h = harness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start", {});
    h.emit("agent_end", {});
    expect(calls).toEqual([1]);
  });

  test("does not notify when the user typed during the run", () => {
    const calls: number[] = [];
    setNotifyForTests((count) => calls.push(count));
    const h = harness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start", {});
    h.type();
    h.emit("agent_end", {});
    expect(calls).toEqual([]);
  });

  test("increments the count across consecutive away completions", () => {
    const calls: number[] = [];
    setNotifyForTests((count) => calls.push(count));
    const h = harness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start", {});
    h.emit("agent_end", {});
    h.emit("agent_start", {});
    h.emit("agent_end", {});
    expect(calls).toEqual([1, 2]);
  });

  test("resets the count when the user comes back and types", () => {
    const calls: number[] = [];
    setNotifyForTests((count) => calls.push(count));
    const h = harness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start", {});
    h.emit("agent_end", {});
    h.type();
    h.emit("agent_start", {});
    h.emit("agent_end", {});
    // The count restarts at one because the acknowledged completion no
    // longer contributes to the unread total.
    expect(calls).toEqual([1, 1]);
  });

  test("suppresses the notification when the user typed during the run", () => {
    const calls: number[] = [];
    setNotifyForTests((count) => calls.push(count));
    const h = harness();
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start", {});
    h.type();
    h.emit("agent_end", {});
    h.emit("agent_start", {});
    h.emit("agent_end", {});
    // Run one was attended; run two was not.
    expect(calls).toEqual([1]);
  });

  test("does not notify without a UI", () => {
    const calls: number[] = [];
    setNotifyForTests((count) => calls.push(count));
    const h = harness();
    (h.ctx as { hasUI: boolean }).hasUI = false;
    h.emit("session_start", { reason: "startup" });
    h.emit("agent_start", {});
    h.emit("agent_end", {});
    expect(calls).toEqual([]);
  });
});
