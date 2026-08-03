import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentDetails } from "./subagent";
import {
  formatCallTitle,
  formatTopLine,
  renderCall,
  renderResult,
} from "./render";

const stubTheme = {
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

type ColorCall = {
  readonly color: ThemeColor;
  readonly text: string;
};

function tracingTheme(): {
  readonly theme: Theme;
  readonly calls: ColorCall[];
} {
  const calls: ColorCall[] = [];
  return {
    calls,
    theme: {
      bold: (text: string) => text,
      italic: (text: string) => text,
      strikethrough: (text: string) => text,
      underline: (text: string) => text,
      fg: (color: ThemeColor, text: string) => {
        calls.push({ color, text });
        return text;
      },
    } as unknown as Theme,
  };
}

const baseDetails: SubagentDetails = {
  returnedOutput: "body",
  fullOutput: "body",
  outputTruncated: false,
  omittedBytes: 0,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    cost: 0.23,
    turns: 3,
    contextTokens: 4000,
  },
  toolCalls: [{ name: "read", title: "src/index.ts", isError: false }],
  activeToolCalls: [],
  lastToolName: "read",
  stopReason: "stop",
  errorMessage: undefined,
  model: "deepseek-v4-flash",
  contextWindow: 1_000_000,
  topLine: "$0.23 ⬝ 0.4%/1.0M ⬝ deepseek-v4-flash ⬝ 3 turns ⬝ 1 tool",
};

function result(text: string): AgentToolResult<SubagentDetails> {
  return { content: [{ type: "text", text }], details: baseDetails };
}

describe("subagent render formatting", () => {
  test("call title uses the first line without truncating", () => {
    const long = `${"x".repeat(140)}\nsecond`;

    expect(formatCallTitle(long)).toBe("x".repeat(140));
  });

  test("top line includes cost, context, model, and activity", () => {
    expect(formatTopLine(baseDetails)).toBe(
      "$0.23 ⬝ 0.4%/1.0M ⬝ deepseek-v4-flash ⬝ 3 turns ⬝ 1 tool"
    );
  });

  test("call title renders prompt markdown", () => {
    const component = renderCall(
      { prompt: "Review **bold** and `code`" },
      stubTheme,
      {
        lastComponent: undefined,
        isPartial: false,
        isError: false,
      }
    );

    expect(component.render(80)[0]?.trimEnd()).toBe(
      " ✓ Subagent Review bold and code"
    );
  });

  test("call title uses a static running marker and a cross on error", () => {
    const running = renderCall({ prompt: "investigate" }, stubTheme, {
      lastComponent: undefined,
      isPartial: true,
      isError: false,
    });
    const runningText = running.render(80)[0] ?? "";
    expect(runningText).toContain("▪");
    expect(runningText).toContain("Subagent");
    expect(runningText).not.toContain("\x1b[38;2;229;216;0m");

    const failed = renderCall({ prompt: "investigate" }, stubTheme, {
      lastComponent: undefined,
      isPartial: false,
      isError: true,
    });
    expect(failed.render(80)[0]).toContain("✗ Subagent ");
  });

  test("call title uses the configured agent name", () => {
    const component = renderCall(
      { agent: "search", prompt: "find this" },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    expect(component.render(80)[0]).toContain("✓ Search find this");
  });

  test("call title uses the default color for prompt text", () => {
    const rendered = tracingTheme();
    renderCall({ prompt: "plain prompt" }, rendered.theme, {
      lastComponent: undefined,
      isPartial: false,
      isError: false,
    }).render(80);

    expect(rendered.calls).not.toContainEqual({
      color: "toolTitle",
      text: "plain prompt",
    });
  });

  test("call title colors the Subagent label with accent while running", () => {
    const pending = tracingTheme();
    renderCall({ prompt: "investigate" }, pending.theme, {
      lastComponent: undefined,
      isPartial: true,
      isError: false,
    }).render(80);

    expect(pending.calls).toContainEqual({
      color: "accent",
      text: "Subagent",
    });

    const done = tracingTheme();
    renderCall({ prompt: "investigate" }, done.theme, {
      lastComponent: undefined,
      isPartial: false,
      isError: false,
    }).render(80);

    expect(done.calls).toContainEqual({ color: "accent", text: "Subagent" });
  });

  test("top line uses muted dots with accent for both running and done content", () => {
    const done = tracingTheme();
    renderResult(
      result("body"),
      { expanded: false, isPartial: false },
      done.theme,
      { lastComponent: undefined, isPartial: false, isError: false }
    ).render(80);

    expect(done.calls).toContainEqual({ color: "accent", text: "$0.23 " });
    expect(done.calls).toContainEqual({ color: "muted", text: "⬝" });

    const running = tracingTheme();
    const runningRender = renderResult(
      {
        content: [{ type: "text", text: "ignored body" }],
        details: { ...baseDetails, stopReason: undefined },
      },
      { expanded: false, isPartial: true },
      running.theme,
      { lastComponent: undefined, isPartial: true, isError: false }
    ).render(80);

    expect(running.calls).toContainEqual({ color: "accent", text: "$0.23 " });
    expect(running.calls).toContainEqual({ color: "muted", text: "⬝" });
    expect(runningRender[0]).toContain("read");
    expect(runningRender.at(-1)).toContain("$0.23 ");
  });

  test("partial render shows the running tool and the top line", () => {
    const runningDetails: SubagentDetails = {
      ...baseDetails,
      toolCalls: [],
      activeToolCalls: [{ name: "grep", title: "" }],
      stopReason: undefined,
      topLine: "$0.23 ⬝ 0.4%/1.0M ⬝ deepseek-v4-flash ⬝ 3 turns ⬝ grep",
    };
    const component = renderResult(
      {
        content: [{ type: "text", text: "ignored body" }],
        details: runningDetails,
      },
      { expanded: false, isPartial: true },
      stubTheme,
      { lastComponent: undefined, isPartial: true, isError: false }
    );

    const lines = component.render(80);
    expect(lines[0]).toContain("grep");
    expect(lines[0]).toContain("▪");
    expect(lines.at(-1)).toContain("$0.23 ");
  });

  test("static running markers do not schedule redraws", () => {
    const runningDetails: SubagentDetails = {
      ...baseDetails,
      toolCalls: [],
      activeToolCalls: [{ name: "read", title: "a.ts" }],
      stopReason: undefined,
      topLine: "$0.01 ⬝ 0.1%/1.0M ⬝ model ⬝ 1 turn ⬝ read",
    };
    let invalidations = 0;
    const context = {
      lastComponent: undefined,
      isPartial: true,
      isError: false,
      invalidate: () => invalidations++,
    };

    const title = renderCall({ prompt: "investigate" }, stubTheme, context);
    const component = renderResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: runningDetails,
      },
      { expanded: false, isPartial: true },
      stubTheme,
      context
    );

    expect(title.render(80)[0]).toContain("▪");
    expect(component.render(80)[0]).toContain("▪");
    expect(invalidations).toBe(0);
  });

  test("long active tool title is truncated to the render width", () => {
    const longTitle =
      "/pi-tui|spinner|render|viewport|scrollback|inline|cursorTo|moveCursor|clearScreen|alternate/";
    const runningDetails: SubagentDetails = {
      ...baseDetails,
      toolCalls: [],
      activeToolCalls: [{ name: "grep", title: longTitle }],
      stopReason: undefined,
      topLine: "$0.03 ⬝ 1.6%/272K ⬝ gpt-5.6-sol ⬝ 1 turn",
    };

    const component = renderResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: runningDetails,
      },
      { expanded: false, isPartial: true },
      stubTheme,
      {
        lastComponent: undefined,
        isPartial: true,
        isError: false,
      }
    );

    const lines = component.render(84);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(84);
    }
  });

  test("collapsed done render shows the final message", () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      "\n"
    );
    const component = renderResult(
      result(body),
      { expanded: false, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    expect(component.render(80)).toEqual([
      " ├─ ✓ read src/index.ts",
      ` ╰─ ${baseDetails.topLine}`,
      ...Array.from({ length: 12 }, (_, i) => `   line ${i + 1}`),
    ]);
  });

  test("expanded done render keeps the top line above the final message", () => {
    const component = renderResult(
      result("line 1\nline 2"),
      { expanded: true, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    expect(component.render(80)).toEqual([
      " ├─ ✓ read src/index.ts",
      ` ╰─ ${baseDetails.topLine}`,
      "   line 1",
      "   line 2",
    ]);
  });

  test("expanded done render renders final message markdown", () => {
    const component = renderResult(
      result("Final **answer** and `code`"),
      { expanded: true, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    expect(component.render(80)).toEqual([
      " ├─ ✓ read src/index.ts",
      ` ╰─ ${baseDetails.topLine}`,
      "   Final answer and code",
    ]);
  });

  test("expanded done render uses configured markdown theme tokens", () => {
    const rendered = tracingTheme();
    renderResult(
      result(
        [
          "# Heading",
          "",
          "[docs](https://example.test)",
          "",
          "`inline`",
          "",
          "> quoted",
          "",
          "- item",
          "",
          "```",
          "plain code",
          "```",
          "",
          "---",
        ].join("\n")
      ),
      { expanded: true, isPartial: false },
      rendered.theme,
      { lastComponent: undefined, isPartial: false, isError: false }
    ).render(120);

    const colors = new Set(rendered.calls.map((call) => call.color));
    const expectedColors = [
      "mdHeading",
      "mdLink",
      "mdCode",
      "mdQuote",
      "mdQuoteBorder",
      "mdListBullet",
      "mdCodeBlock",
      "mdCodeBlockBorder",
      "mdHr",
    ] satisfies readonly ThemeColor[];

    for (const color of expectedColors) {
      expect(colors.has(color)).toBe(true);
    }
  });

  test("expanded done render uses the default color for final message text", () => {
    const rendered = tracingTheme();
    renderResult(
      result("plain final"),
      { expanded: true, isPartial: false },
      rendered.theme,
      { lastComponent: undefined, isPartial: false, isError: false }
    ).render(80);

    expect(rendered.calls).not.toContainEqual({
      color: "toolOutput",
      text: "plain final",
    });
  });

  test("subagent with no tool calls uses gapped prefix, not tree connectors", () => {
    const noToolsDetails: SubagentDetails = {
      ...baseDetails,
      toolCalls: [],
      activeToolCalls: [],
      topLine: "$0.01 ⬝ 0.1%/1.0M ⬝ model ⬝ 1 turn",
    };
    const component = renderResult(
      { content: [{ type: "text", text: "answer" }], details: noToolsDetails },
      { expanded: false, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    const lines = component.render(80);
    expect(lines).toEqual([
      "   $0.01 ⬝ 0.1%/1.0M ⬝ model ⬝ 1 turn",
      "   answer",
    ]);
    expect(lines[0]).not.toContain("├");
    expect(lines[0]).not.toContain("╰");
  });

  test("multiple completed tool calls get incremental tree branches", () => {
    const multiDetails: SubagentDetails = {
      ...baseDetails,
      toolCalls: [
        { name: "glob", title: "*.ts", isError: false },
        { name: "read", title: "a.ts", isError: false },
        { name: "bash", title: "ls", isError: true },
      ],
      activeToolCalls: [],
    };
    const component = renderResult(
      { content: [{ type: "text", text: "done" }], details: multiDetails },
      { expanded: false, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );

    const lines = component.render(80);
    expect(lines[0]).toContain("├─ ✓ glob *.ts");
    expect(lines[1]).toContain("├─ ✓ read a.ts");
    expect(lines[2]).toContain("├─ ✗ bash ls");
    expect(lines[3]).toContain("╰─");
    expect(lines[3]).toContain(baseDetails.topLine);
    expect(lines[4]).toBe("   done");
  });

  test("plain subagent (no agent name) renders tool calls the same way", () => {
    const component = renderCall({ prompt: "do something" }, stubTheme, {
      lastComponent: undefined,
      isPartial: false,
      isError: false,
    });
    expect(component.render(80)[0]).toContain("Subagent");

    const plainDetails: SubagentDetails = {
      ...baseDetails,
      toolCalls: [{ name: "bash", title: "echo hi", isError: false }],
    };
    const rendered = renderResult(
      { content: [{ type: "text", text: "result" }], details: plainDetails },
      { expanded: false, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );
    const lines = rendered.render(80);
    expect(lines[0]).toContain("├─ ✓ bash echo hi");
    expect(lines[1]).toContain("╰─");
    expect(lines[2]).toBe("   result");
  });

  test("collapsed body truncates to last 15 lines with overflow indicator", () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join(
      "\n"
    );
    const component = renderResult(
      result(body),
      { expanded: false, isPartial: false },
      stubTheme,
      { lastComponent: undefined, isPartial: false, isError: false }
    );
    const lines = component.render(80);
    // tree lines + overflow line + 15 preview lines
    expect(lines[0]).toContain("├─ ✓ read src/index.ts");
    expect(lines[1]).toContain("╰─");
    expect(lines[2]).toBe("   … 15 more lines");
    expect(lines[3]).toBe("   line 16");
    expect(lines.at(-1)).toBe("   line 30");
    expect(lines.length).toBe(2 + 1 + 15);
  });
});
