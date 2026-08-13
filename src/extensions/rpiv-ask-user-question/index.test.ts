import { describe, expect, test } from "bun:test";
import entry from "./index";

describe("rpiv-ask-user-question extension entry", () => {
  test("registers ask_user_question tool via a minimal pi stub", async () => {
    const registered: string[] = [];
    const noop = () => {};
    const pi: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "registerTool") {
            return (def: any) => registered.push(def.name);
          }
          if (prop === "events") {
            return { emit: noop, on: () => noop };
          }
          return noop;
        },
      }
    );
    await expect(entry(pi)).resolves.toBeUndefined();
    expect(registered).toContain("ask_user_question");
  });

  test("bridges rpiv:ask-user:blocked to herdr:blocked", async () => {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const bus = {
      emit(channel: string, data: unknown) {
        listeners.get(channel)?.forEach((h) => h(data));
      },
      on(channel: string, handler: (data: unknown) => void) {
        let set = listeners.get(channel);
        if (!set) {
          set = new Set();
          listeners.set(channel, set);
        }
        set.add(handler);
        return () => set!.delete(handler);
      },
    };
    const pi: any = {
      registerTool: (def: any) => void def,
      on: () => () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      events: bus,
    };

    await entry(pi);

    const herdr: Array<{ active: boolean; label?: string }> = [];
    bus.on("herdr:blocked", (d) =>
      herdr.push(d as { active: boolean; label?: string })
    );

    bus.emit("rpiv:ask-user:blocked", { active: true });
    bus.emit("rpiv:ask-user:blocked", { active: false });

    expect(herdr).toEqual([
      { active: true, label: "Awaiting your answer" },
      { active: false },
    ]);
  });
});
