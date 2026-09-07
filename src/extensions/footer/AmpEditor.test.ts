import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AmpEditor, fitBorder } from "./AmpEditor";

describe("fitBorder", () => {
  test("places status text inside a full-width editor border", () => {
    const rendered = fitBorder(
      " 9% of 300K ",
      " smart 14-skills ",
      60,
      (s) => s
    );

    expect(rendered).toStartWith("─ 9% of 300K ");
    expect(rendered).toEndWith(" smart 14-skills ─");
    expect(visibleWidth(rendered)).toBe(60);
  });

  test("truncates labels before exceeding narrow widths", () => {
    for (const width of [0, 1, 5, 10, 20]) {
      const rendered = fitBorder(
        " long context label ",
        " long model label ",
        width,
        (s) => s
      );
      expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
    }
  });

  test("centers the scroll marker between the labels", () => {
    const rendered = fitBorder(
      " 9% of 300K ",
      " model ",
      60,
      (s) => s,
      " ↑ 4 "
    );

    expect(rendered).toContain(" ↑ 4 ");
    expect(visibleWidth(rendered)).toBe(60);
  });

  test("drops the scroll marker instead of squeezing the labels", () => {
    const rendered = fitBorder(" context ", " model ", 22, (s) => s, " ↑ 4 ");

    expect(rendered).not.toContain("↑");
    expect(rendered).toStartWith("─ context ");
    expect(visibleWidth(rendered)).toBe(22);
  });

  test("truncates long ANSI and wide-character labels in one pass", () => {
    const rendered = fitBorder(
      " context ",
      ` \x1b[32m${"模型".repeat(100)}\x1b[39m `,
      40,
      (s) => s
    );

    expect(rendered).toStartWith("─ context ");
    expect(visibleWidth(rendered)).toBe(40);
  });
});

type BorderRenderer = {
  renderTopBorder(width: number, hiddenLineCount: number): string;
  renderBottomBorder(width: number, hiddenLineCount: number): string;
  setWorkingStatusIndicator(indicator: unknown): void;
};

function makeEditor(cost = 0): BorderRenderer {
  const theme = {
    fg: (_color: string, text: string) => text,
  };
  const editor = new AmpEditor(
    {} as never,
    { borderColor: (text: string) => text } as never,
    {} as never,
    {
      pi: { getThinkingLevel: () => "smart" },
      ctx: {
        ui: { theme },
        model: { provider: "hdwebsoft-proxy", id: "gemini-3.8-flash" },
        sessionManager: { getCwd: () => "/tmp/repo" },
      },
      getGitState: () => ({ branch: "", dirty: false, ahead: 0, behind: 0 }),
      getStats: () => ({ cost, contextText: "9% of 300K" }),
      initialHistory: [],
    } as never
  );
  return editor as unknown as BorderRenderer;
}

const workingStatus = {
  renderInBorder: (width: number) => "⣾ Working…".slice(0, width),
  renderSpinnerInBorder: () => "⣾",
};

describe("AmpEditor borders", () => {
  test("shows context and model chips while idle", () => {
    const rendered = makeEditor().renderTopBorder(60, 0);

    expect(rendered).toStartWith("─ 9% of 300K ");
    expect(rendered).toEndWith(" smart hdwebsoft-proxy/gemini-3.8-flash ─");
    expect(visibleWidth(rendered)).toBe(60);
  });

  test("replaces the context chip with the embedded working status", () => {
    const editor = makeEditor();
    editor.setWorkingStatusIndicator(workingStatus);
    const rendered = editor.renderTopBorder(60, 0);

    expect(rendered).toStartWith("─ ⣾ Working… ");
    expect(rendered).not.toContain("9% of 300K");
    expect(rendered).toEndWith(" smart hdwebsoft-proxy/gemini-3.8-flash ─");
  });

  test("falls back to the bare spinner when the label would crowd the model", () => {
    const editor = makeEditor();
    editor.setWorkingStatusIndicator(workingStatus);
    const rendered = editor.renderTopBorder(46, 0);

    expect(rendered).toStartWith("─ ⣾ ");
    expect(rendered).not.toContain("Working");
    expect(visibleWidth(rendered)).toBe(46);
  });

  test("restores the context chip once the status is cleared", () => {
    const editor = makeEditor();
    editor.setWorkingStatusIndicator(workingStatus);
    editor.setWorkingStatusIndicator(undefined);

    expect(editor.renderTopBorder(60, 0)).toStartWith("─ 9% of 300K ");
  });

  test("keeps the editor's scroll markers", () => {
    const editor = makeEditor(1.5);

    expect(editor.renderTopBorder(60, 4)).toContain("↑ 4 ");
    expect(editor.renderBottomBorder(60, 2)).toContain("↓ 2 ");
  });

  test("shows cost and cwd on the bottom border", () => {
    const rendered = makeEditor(1.5).renderBottomBorder(60, 0);

    expect(rendered).toStartWith("─ $1.50 ");
    expect(rendered).toEndWith(" /tmp/repo ─");
    expect(visibleWidth(rendered)).toBe(60);
  });
});
