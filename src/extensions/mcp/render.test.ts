import { describe, expect, test } from "bun:test";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { OutputBudget } from "../../shared/OutputBudget";
import { capMcpResult, decorateMcpTool } from "./render";

type ToolContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function context(isError = false): ToolContext {
  return {
    args: {},
    toolCallId: "mcp-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError,
  };
}

function tool(name: string, label: string): ToolDefinition {
  return {
    name,
    label,
    description: "test",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

describe("MCP renderer", () => {
  test("renders proxy calls as a compact direct-style title", () => {
    const decorated = decorateMcpTool(tool("mcp", "MCP"));
    const rendered = decorated.renderCall!(
      {
        tool: "web_search_exa",
        server: "exa",
        args: '{"query":"Claude Code","numResults":2}',
      },
      theme,
      context()
    )
      .render(160)
      .join("\n");

    expect(rendered).toContain(
      '✓ mcp__exa__web_search_exa {"query":"Claude Code","numResults":2}'
    );
  });

  test("renders direct MCP tools with a cross on errors", () => {
    const decorated = decorateMcpTool(
      tool("exa_web_fetch_exa", "MCP: web_fetch_exa")
    );
    const rendered = decorated.renderCall!(
      { urls: ["https://example.com"] },
      theme,
      context(true)
    )
      .render(160)
      .join("\n");

    expect(rendered).toContain(
      '✗ mcp__exa__web_fetch_exa {"urls":["https://example.com"]}'
    );
  });

  test("leaves unrelated tools unchanged", () => {
    const original = tool("read", "read");
    expect(decorateMcpTool(original)).toBe(original);
  });
});

describe("capMcpResult", () => {
  test("returns small results untouched", async () => {
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    };
    expect(await capMcpResult(result)).toBe(result);
  });

  test("caps oversized text and spills the full output", async () => {
    const big = "x".repeat(OutputBudget.maxBytes * 3);
    const result = {
      content: [{ type: "text" as const, text: big }],
      details: {},
    };

    const capped = await capMcpResult(result);
    const block = capped.content[0] as { readonly text: string };
    expect(block.text.length).toBeLessThan(big.length);
    expect(block.text).toContain("[mcp: output truncated");

    const pathMatch = /full output saved to (\S+) —/.exec(block.text);
    expect(pathMatch).not.toBeNull();
    const spillPath = pathMatch![1]!;
    try {
      expect(await Bun.file(spillPath).text()).toBe(big);
    } finally {
      await Bun.file(spillPath).unlink();
    }
  });

  test("preserves non-text blocks", async () => {
    const image = {
      type: "image" as const,
      data: "abc",
      mimeType: "image/png",
    };
    const result = {
      content: [image, { type: "text" as const, text: "small" }],
      details: {},
    };
    const capped = await capMcpResult(result);
    expect(capped.content[0]).toBe(image);
  });
});
