import type {
  ExtensionAPI,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { OutputBudget } from "../../shared/OutputBudget";
import {
  Renderer,
  type StatefulToolCallTitleContext,
} from "../../shared/Renderer";
import { SpillCache } from "../../shared/SpillCache";

type McpProxyInput = {
  readonly tool?: string;
  readonly args?: string;
  readonly connect?: string;
  readonly describe?: string;
  readonly search?: string;
  readonly server?: string;
  readonly action?: string;
};

type McpRenderContext = StatefulToolCallTitleContext & {
  readonly args?: unknown;
};

function compactJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return JSON.stringify(value) ?? "";
}

function proxyTitle(input: McpProxyInput): string {
  if (input.tool) {
    return input.server
      ? `mcp__${input.server}__${input.tool}`
      : directTitle(input.tool);
  }
  if (input.connect) {
    return `mcp connect ${input.connect}`;
  }
  if (input.describe) {
    return `mcp describe ${input.describe}`;
  }
  if (input.search) {
    return `mcp search ${input.search}${input.server ? ` @ ${input.server}` : ""}`;
  }
  if (input.server) {
    return `mcp list ${input.server}`;
  }
  if (input.action) {
    return `mcp ${input.action}`;
  }
  return "mcp status";
}

function directTitle(name: string): string {
  if (name.startsWith("mcp__")) {
    return name;
  }
  const separator = name.indexOf("_");
  if (separator === -1) {
    return `mcp__${name}`;
  }
  return `mcp__${name.slice(0, separator)}__${name.slice(separator + 1)}`;
}

function isMcpTool(tool: ToolDefinition): boolean {
  return tool.name === "mcp" || tool.label.startsWith("MCP:");
}

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

/**
 * MCP servers are external and can return arbitrarily large results; without
 * a cap they flow straight into the model context. Cap the combined text
 * blocks at the standard output budget and spill the full text to the cache
 * so the model can read the remainder on demand.
 */
export async function capMcpResult(result: ToolResult): Promise<ToolResult> {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return result;
  }

  let remaining = OutputBudget.maxBytes;
  let truncatedAny = false;
  const capped: typeof content = [];

  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") {
      capped.push(block);
      continue;
    }
    // Never cap a block below 1KB so later blocks still identify themselves.
    const budget = Math.max(1024, remaining);
    const { body, returnedBytes, totalBytes, truncated } =
      OutputBudget.truncateUtf8(block.text, budget);
    remaining = Math.max(0, remaining - returnedBytes);
    if (!truncated) {
      capped.push(block);
      continue;
    }
    truncatedAny = true;
    const path = await SpillCache.write("mcp", "txt", block.text);
    const note = path
      ? `\n[mcp: output truncated, showing ${returnedBytes} of ${totalBytes} bytes; full output saved to ${path} — use the read tool to view more.]`
      : `\n[mcp: output truncated, showing ${returnedBytes} of ${totalBytes} bytes.]`;
    capped.push({ ...block, text: body + note });
  }

  return truncatedAny ? { ...result, content: capped } : result;
}

export function decorateMcpTool(tool: ToolDefinition): ToolDefinition {
  if (!isMcpTool(tool)) {
    return tool;
  }

  const renderTitle = (
    args: unknown,
    theme: Theme,
    context: McpRenderContext
  ) => {
    const input = (args ?? {}) as Record<string, unknown> & McpProxyInput;
    const isProxy = tool.name === "mcp";
    const title = isProxy ? proxyTitle(input) : directTitle(tool.name);
    const callArgs = isProxy ? input.args : input;
    const suffix = callArgs ? ` ${compactJson(callArgs)}` : "";
    const markerColor = Renderer.markerColorFor(
      Boolean(context.isPartial),
      Boolean(context.isError)
    );

    return Renderer.renderStatefulToolCallTitle({
      label: title,
      title: theme.fg("muted", suffix),
      theme,
      context,
      markerGlyph: Renderer.markerGlyphFor(markerColor),
      separator: "",
      useSpinner: true,
    });
  };

  return {
    ...tool,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx
      );
      return capMcpResult(result);
    },
    renderCall(args, theme, context) {
      return renderTitle(args, theme, context);
    },
    renderResult(_result, _options, theme, context) {
      renderTitle(context.args, theme, context);
      return new Container();
    },
  };
}

export function withMcpRenderer(pi: ExtensionAPI): ExtensionAPI {
  SpillCache.installSweeper();
  const registerTool = pi.registerTool.bind(pi);
  const wrapped = Object.create(pi) as ExtensionAPI;
  wrapped.registerTool = ((tool: ToolDefinition) => {
    registerTool(decorateMcpTool(tool));
  }) as ExtensionAPI["registerTool"];
  return wrapped;
}
