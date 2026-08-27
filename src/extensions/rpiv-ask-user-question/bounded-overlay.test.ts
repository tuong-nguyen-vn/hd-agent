import { describe, expect, test } from "bun:test";
import {
  OVERLAY_MAX_HEIGHT_PERCENT,
  boundedOverlayContext,
  boundedRows,
  boundedTui,
  withBoundedOverlay,
} from "./bounded-overlay";

describe("boundedRows", () => {
  test("matches pi-tui's percentage parsing for maxHeight", () => {
    expect(boundedRows(40)).toBe(28);
    expect(boundedRows(24)).toBe(16);
    expect(boundedRows(1)).toBe(1);
    expect(boundedRows(0)).toBe(1);
  });
});

describe("boundedTui", () => {
  test("caps terminal.rows and keeps other members bound to the real TUI", () => {
    const receivers: unknown[] = [];
    const tui: any = {
      terminal: { rows: 40, columns: 120, hideCursor() {} },
      requestRender() {
        receivers.push(this);
      },
    };
    const bounded = boundedTui(tui);
    expect(bounded.terminal.rows).toBe(28);
    expect(bounded.terminal.columns).toBe(120);
    bounded.requestRender();
    expect(receivers).toEqual([tui]);

    tui.terminal.rows = 24;
    expect(bounded.terminal.rows).toBe(16);
  });
});

describe("boundedOverlayContext", () => {
  function makeCtx() {
    const calls: Array<{ factory: any; options: any }> = [];
    const ctx: any = {
      get hasUI() {
        return true;
      },
      cwd: "/repo",
      ui: {
        custom(factory: any, options: any) {
          calls.push({ factory, options });
          return Promise.resolve("done");
        },
        notify() {},
      },
    };
    return { ctx, calls };
  }

  test("forces overlay maxHeight and hands the factory a bounded tui", async () => {
    const { ctx, calls } = makeCtx();
    const seenRows: number[] = [];
    const bounded = boundedOverlayContext(ctx);

    const result = await bounded.ui.custom(
      (tui) => {
        seenRows.push(tui.terminal.rows);
        return { render: () => [], invalidate() {}, handleInput() {} };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "bottom-center", maxHeight: "100%" },
      }
    );

    expect(result).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.overlayOptions).toEqual({
      anchor: "bottom-center",
      maxHeight: `${OVERLAY_MAX_HEIGHT_PERCENT}%`,
    });

    calls[0]!.factory({ terminal: { rows: 50 } }, {}, {}, () => {});
    expect(seenRows).toEqual([35]);
  });

  test("resolves function-form overlayOptions before capping", async () => {
    const { ctx, calls } = makeCtx();
    await boundedOverlayContext(ctx).ui.custom(() => ({}) as any, {
      overlay: true,
      overlayOptions: () => ({ width: "100%", maxHeight: 999 }),
    });
    expect(calls[0]!.options.overlayOptions).toEqual({
      width: "100%",
      maxHeight: `${OVERLAY_MAX_HEIGHT_PERCENT}%`,
    });
  });

  test("leaves non-overlay custom() calls untouched", async () => {
    const { ctx, calls } = makeCtx();
    const factory = () => ({}) as any;
    await boundedOverlayContext(ctx).ui.custom(factory);
    expect(calls[0]!.factory).toBe(factory);
    expect(calls[0]!.options).toBeUndefined();
  });

  test("passes through other ctx and ui members", () => {
    const { ctx } = makeCtx();
    const bounded = boundedOverlayContext(ctx);
    expect(bounded.hasUI).toBe(true);
    expect(bounded.cwd).toBe("/repo");
    expect(typeof bounded.ui.notify).toBe("function");
  });
});

describe("withBoundedOverlay", () => {
  test("wraps execute so the tool sees a bounded ctx", async () => {
    let seen: any;
    const def: any = {
      name: "ask_user_question",
      label: "x",
      description: "x",
      parameters: {},
      execute: async (
        _id: string,
        _p: unknown,
        _s: unknown,
        _u: unknown,
        ctx: any
      ) => {
        seen = ctx;
        return { content: [], details: {} };
      },
    };
    const wrapped = withBoundedOverlay(def);
    const calls: any[] = [];
    await wrapped.execute("id", {}, undefined as any, () => {}, {
      ui: {
        custom: (_f: any, o: any) => {
          calls.push(o);
          return Promise.resolve(undefined);
        },
      },
    } as any);
    await seen.ui.custom(() => ({}), { overlay: true, overlayOptions: {} });
    expect(calls[0].overlayOptions.maxHeight).toBe(
      `${OVERLAY_MAX_HEIGHT_PERCENT}%`
    );
    expect(wrapped.name).toBe("ask_user_question");
  });
});
