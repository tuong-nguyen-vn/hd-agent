import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { boundedRows } from "./bounded-overlay";
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

  test("caps the questionnaire overlay so the transcript stays visible", async () => {
    let def: any;
    const pi: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "registerTool") {
            return (d: any) => void (def = d);
          }
          if (prop === "events") {
            return { emit() {}, on: () => () => {} };
          }
          return () => {};
        },
      }
    );
    await entry(pi);

    initTheme("dark");
    const theme: any = new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) =>
            String(args[args.length - 1] ?? ""),
      }
    );
    const rows = 30;
    const tui: any = {
      terminal: { rows, columns: 100, hideCursor() {}, showCursor() {} },
      requestRender() {},
      setFocus() {},
    };
    let overlayOptions: any;
    let lines: string[] = [];
    const ctx: any = {
      hasUI: true,
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      ui: {
        custom: async (factory: any, options: any) => {
          overlayOptions = options.overlayOptions;
          const component = await factory(tui, theme, {}, () => {});
          lines = component.render(100);
          return { answers: [], cancelled: true };
        },
        notify() {},
      },
    };
    // Four long-description options overflow a 30-row terminal on their own,
    // so the dialog has to scroll rather than spill past the overlay cap.
    const questions = [
      {
        question: "Which one?",
        header: "Pick",
        options: Array.from({ length: 4 }, (_, i) => ({
          label: `Option ${i}`,
          description: "desc ".repeat(30),
        })),
      },
    ];

    await def.execute("id", { questions }, undefined, () => {}, ctx);

    expect(overlayOptions).toMatchObject({
      anchor: "bottom-center",
      maxHeight: "70%",
    });
    expect(lines).toHaveLength(boundedRows(rows));
    expect(lines[lines.length - 1]).toContain("Enter to select");
  });
});
