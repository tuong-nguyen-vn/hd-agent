import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  DefaultTextStyle,
  MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  Container,
  Markdown,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type PrefixSpec, Renderer } from "../../shared/Renderer";
import type {
  SubagentActiveTool,
  SubagentDetails,
  SubagentSnapshot,
  SubagentToolCall,
} from "./subagent";

const DOT = "⬝";
const CONTINUATION_PREFIX = "   ";
const TREE_MID_PREFIX = " ├─ ";
const TREE_END_PREFIX = " ╰─ ";
const BODY_PREVIEW_LINES = 15;
const RUNNING_MARKER = "▪";

export const ACTIVE_YELLOW = "\x1b[38;2;229;216;0m";
const FG_RESET = "\x1b[39m";

type RenderContext = {
  readonly lastComponent: Component | undefined;
  readonly isPartial: boolean;
  readonly isError: boolean;
};

type StatusFields = Pick<
  SubagentSnapshot,
  | "usage"
  | "toolCalls"
  | "activeToolCalls"
  | "lastToolName"
  | "stopReason"
  | "model"
  | "contextWindow"
>;

type MarkdownBlockArgs = {
  readonly text: string;
  readonly theme: Theme;
  readonly prefix: PrefixSpec;
  readonly lineColor?: ThemeColor;
};

class MarkdownTitle implements Component {
  private label = "";
  private title = "";
  private theme: Theme | undefined;
  private context: RenderContext | undefined;
  private labelColor: ThemeColor | undefined;

  public set(args: {
    readonly label: string;
    readonly title: string;
    readonly theme: Theme;
    readonly context: RenderContext;
    readonly labelColor?: ThemeColor;
  }): void {
    this.label = args.label;
    this.title = args.title;
    this.theme = args.theme;
    this.context = args.context;
    this.labelColor = args.labelColor;
  }

  public render(width: number): string[] {
    const theme = this.theme;
    const context = this.context;
    if (!theme || !context) {
      return [];
    }

    const markerColor = Renderer.markerColorFor(
      Boolean(context.isPartial),
      Boolean(context.isError)
    );
    const marker = context.isPartial
      ? RUNNING_MARKER
      : context.isError
        ? "✗"
        : "✓";
    const isActive = context.isPartial;
    const markerStr = isActive
      ? `${ACTIVE_YELLOW} ${marker}${FG_RESET}`
      : theme.fg(markerColor, ` ${marker}`);
    const labelStr = isActive
      ? `${ACTIVE_YELLOW}${theme.bold(this.label)}${FG_RESET}`
      : theme.fg(this.labelColor ?? "toolTitle", theme.bold(this.label));
    const prefix = markerStr + " " + labelStr + theme.fg("toolTitle", " ");
    const inner = Math.max(1, width - visibleWidth(prefix));
    const titleLines = renderMarkdownLines({
      text: this.title,
      theme,
      width: inner,
    });
    const lines = titleLines.length > 0 ? titleLines : [""];
    const out = [prefix + (lines[0] ?? "")];

    for (const line of lines.slice(1)) {
      out.push(theme.fg("toolOutput", CONTINUATION_PREFIX) + line);
    }

    return out;
  }

  public invalidate(): void {}
}

export function formatCallTitle(prompt: string | undefined): string {
  return (prompt ?? "...").split(/\r?\n/u)[0]?.trim() || "...";
}

/**
 * Renders the subagent's status block: child tool-call lines (collapsed —
 * name + title only, no results), followed by the metadata top line. The
 * title and active child tools use the same pending marker.
 */
class SubagentStatusView implements Component {
  private toolCalls: readonly SubagentToolCall[] = [];
  private activeTools: readonly SubagentActiveTool[] = [];
  private topLine = "";
  private theme: Theme | undefined;
  private isPartial = false;
  private context: RenderContext | undefined;

  public set(args: {
    readonly toolCalls: readonly SubagentToolCall[];
    readonly activeTools: readonly SubagentActiveTool[];
    readonly topLine: string;
    readonly theme: Theme;
    readonly isPartial: boolean;
    readonly context: RenderContext;
  }): void {
    this.toolCalls = args.toolCalls;
    this.activeTools = args.activeTools;
    this.topLine = args.topLine;
    this.theme = args.theme;
    this.isPartial = args.isPartial;
    this.context = args.context;
  }

  public render(width: number): string[] {
    const theme = this.theme;
    if (!theme) {
      return [];
    }

    type LineGen = (prefix: string) => string;
    const items: LineGen[] = [];

    for (const call of this.toolCalls) {
      items.push((prefix) => renderToolCallLine(call, prefix, theme));
    }

    if (this.isPartial) {
      for (const tool of this.activeTools) {
        items.push((prefix) => renderActiveToolLine(tool, prefix, theme));
      }
    }

    if (this.topLine) {
      const styled = this.isPartial
        ? styleActiveLine(this.topLine, theme)
        : styleDottedLine({
            text: this.topLine,
            theme,
            lineColor: "accent",
          });
      items.push((prefix) => prefix + styled);
    }

    const hasTools = this.toolCalls.length > 0 || this.activeTools.length > 0;
    const lines: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const isLast = i === items.length - 1;
      const prefix = hasTools
        ? theme.fg("muted", isLast ? TREE_END_PREFIX : TREE_MID_PREFIX)
        : Renderer.GAPPED_PREFIX.prefix;
      lines.push(truncateToWidth(items[i]!(prefix), width, ""));
    }
    return lines;
  }

  public invalidate(): void {}
}

function renderToolCallLine(
  call: SubagentToolCall,
  connector: string,
  theme: Theme
): string {
  const marker = call.isError ? "✗" : "✓";
  const markerColor = call.isError ? "error" : "success";
  return (
    connector +
    theme.fg(markerColor, marker) +
    " " +
    theme.bold(call.name) +
    (call.title ? theme.fg("toolOutput", " " + call.title) : "")
  );
}

function renderActiveToolLine(
  tool: SubagentActiveTool,
  connector: string,
  theme: Theme
): string {
  return (
    connector +
    ACTIVE_YELLOW +
    RUNNING_MARKER +
    FG_RESET +
    " " +
    ACTIVE_YELLOW +
    theme.bold(tool.name) +
    FG_RESET +
    (tool.title ? ` ${ACTIVE_YELLOW}${tool.title}${FG_RESET}` : "")
  );
}

function formatAgentLabel(agent: string | undefined): string {
  const trimmed = agent?.trim();
  if (!trimmed) {
    return "Subagent";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function formatTopLine(snapshot: StatusFields): string {
  return [
    formatCost(snapshot.usage.cost),
    formatContext(snapshot),
    snapshot.model ?? "unknown model",
    formatActivity(snapshot),
  ].join(` ${DOT} `);
}

export function renderCall(
  args: { readonly agent?: string; readonly prompt?: string } | undefined,
  theme: Theme,
  context: RenderContext
): Component {
  const component =
    context.lastComponent instanceof MarkdownTitle
      ? context.lastComponent
      : new MarkdownTitle();
  component.set({
    label: formatAgentLabel(args?.agent),
    title: formatCallTitle(args?.prompt),
    theme,
    context,
    labelColor: titleColorFor(context),
  });
  return component;
}

export function renderResult(
  result: AgentToolResult<SubagentDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderContext
): Component {
  const view =
    context.lastComponent instanceof SubagentResult
      ? context.lastComponent
      : new SubagentResult();
  view.update(result, options, theme, context);
  return view;
}

/**
 * Renders the complete subagent result: child tool-call lines, the metadata
 * top line, and the final output body (when complete/expanded). The tool-call
 * and top-line status block is delegated to a reused SubagentStatusView. The
 * running marker is static so it never schedules redraws that force terminal
 * scroll. The body is rendered as a
 * plain prefixed block (collapsed) or markdown (expanded), matching the prior
 * behavior for the subagent's final message.
 */
class SubagentResult implements Component {
  private readonly statusView = new SubagentStatusView();
  private bodyComponent: Component | undefined;
  private lastBodyKey = "";

  public update(
    result: AgentToolResult<SubagentDetails>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext
  ): void {
    const details = result.details;
    const first = result.content?.[0];
    const body = first && "text" in first ? (first.text ?? "") : "";
    const topLine = details?.topLine ?? "";

    this.statusView.set({
      toolCalls: details?.toolCalls ?? [],
      activeTools: details?.activeToolCalls ?? [],
      topLine,
      theme,
      isPartial: Boolean(options.isPartial),
      context,
    });

    const showBody = !options.isPartial && body.length > 0;
    if (showBody) {
      const key = `${options.expanded ? "md" : "txt"}|${body}`;
      if (key !== this.lastBodyKey) {
        this.bodyComponent = options.expanded
          ? makePrefixedMarkdownBlock({
              text: body,
              theme,
              prefix: Renderer.GAPPED_PREFIX,
              lineColor: expandedResultColor(details, context.isError),
            })
          : makeCollapsedBody(body, theme, details, context.isError);
        this.lastBodyKey = key;
      }
    } else {
      this.bodyComponent = undefined;
      this.lastBodyKey = "";
    }
  }

  public render(width: number): string[] {
    const lines = this.statusView.render(width);
    if (this.bodyComponent) {
      lines.push(...this.bodyComponent.render(width));
    }
    return lines;
  }

  public invalidate(): void {}
}

/**
 * Collapsed body: show only the last BODY_PREVIEW_LINES lines, preceded by
 * a `… N more lines` overflow indicator. Matches the pattern used by bash
 * and grep tools (previewFromEnd).
 */
function makeCollapsedBody(
  body: string,
  theme: Theme,
  details: SubagentDetails | undefined,
  isError: boolean
): Component {
  const container = new Container();
  const lineColor = resultColor(details, isError);
  const block = (text: string): Component =>
    Renderer.makePrefixedBlock({
      text,
      theme,
      prefix: Renderer.GAPPED_PREFIX,
      lineColor,
    });
  const mutedBlock = (text: string): Component =>
    Renderer.makePrefixedBlock({
      text,
      theme,
      prefix: Renderer.GAPPED_PREFIX,
      lineColor: "muted",
    });

  const lines = body.split("\n");
  const overflow = Math.max(0, lines.length - BODY_PREVIEW_LINES);
  const preview =
    overflow > 0 ? lines.slice(-BODY_PREVIEW_LINES).join("\n") : body;
  if (overflow > 0) {
    container.addChild(mutedBlock(`… ${overflow} more lines`));
  }
  if (preview) {
    container.addChild(block(preview));
  }
  container.invalidate();
  return container;
}

function makePrefixedMarkdownBlock(args: MarkdownBlockArgs): Component {
  const markdown = new Markdown(
    args.text,
    0,
    0,
    makeMarkdownTheme(args.theme),
    defaultStyle(args.theme, args.lineColor)
  );

  return {
    render(width: number): string[] {
      const inner = Math.max(1, width - args.prefix.width);
      return markdown.render(inner).map((line) => {
        return (
          args.theme.fg("toolOutput", args.prefix.prefix) +
          trimRenderedLine(line)
        );
      });
    },
    invalidate(): void {
      markdown.invalidate();
    },
  };
}

function renderMarkdownLines(args: {
  readonly text: string;
  readonly theme: Theme;
  readonly width: number;
  readonly lineColor?: ThemeColor;
}): string[] {
  const markdown = new Markdown(
    args.text,
    0,
    0,
    makeMarkdownTheme(args.theme),
    defaultStyle(args.theme, args.lineColor)
  );
  return markdown.render(args.width).map(trimRenderedLine);
}

function defaultStyle(
  theme: Theme,
  lineColor: ThemeColor | undefined
): DefaultTextStyle | undefined {
  return lineColor
    ? { color: (text: string) => theme.fg(lineColor, text) }
    : undefined;
}

function makeMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text: string) => theme.fg("mdHeading", text),
    link: (text: string) => theme.fg("mdLink", text),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(text),
    underline: (text: string) => theme.underline(text),
    strikethrough: (text: string) => theme.strikethrough(text),
  };
}

function trimRenderedLine(line: string): string {
  return line.trimEnd();
}

function styleDottedLine(args: {
  readonly text: string;
  readonly theme: Theme;
  readonly lineColor: ThemeColor;
}): string {
  return args.text
    .split(DOT)
    .map((part) => args.theme.fg(args.lineColor, part))
    .join(args.theme.fg("muted", DOT));
}

function styleActiveLine(text: string, theme: Theme): string {
  return text
    .split(DOT)
    .map((part) => `${ACTIVE_YELLOW}${part}${FG_RESET}`)
    .join(theme.fg("muted", DOT));
}

function titleColorFor(context: RenderContext): ThemeColor {
  if (context.isPartial) {
    return "warning";
  }
  if (context.isError) {
    return "error";
  }
  return "accent";
}

function resultColor(
  details: SubagentDetails | undefined,
  isError: boolean
): "toolOutput" | "error" | "warning" {
  if (details?.stopReason === "aborted") {
    return "warning";
  }
  return isError ? "error" : "toolOutput";
}

function expandedResultColor(
  details: SubagentDetails | undefined,
  isError: boolean
): "error" | "warning" | undefined {
  if (details?.stopReason === "aborted") {
    return "warning";
  }
  return isError ? "error" : undefined;
}

function formatActivity(snapshot: StatusFields): string {
  const turns = `${snapshot.usage.turns} ${snapshot.usage.turns === 1 ? "turn" : "turns"}`;
  if (snapshot.stopReason !== undefined) {
    const toolCount = snapshot.toolCalls.length;
    return toolCount > 0
      ? `${turns} ${DOT} ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`
      : turns;
  }

  return `${turns} ${DOT} ${activeToolLabel(snapshot)}`;
}

function activeToolLabel(snapshot: StatusFields): string {
  const active = snapshot.activeToolCalls;
  if (active.length === 1) {
    return active[0]!.name;
  }
  if (active.length > 1) {
    return `${active.length} tools`;
  }
  return snapshot.lastToolName ?? "thinking";
}

function formatContext(snapshot: StatusFields): string {
  const window = snapshot.contextWindow;
  if (!window || window <= 0) {
    return "?/?";
  }
  const windowText = formatTokens(window);
  const tokens = snapshot.usage.contextTokens;
  if (tokens === undefined) {
    return `?/${windowText}`;
  }
  return `${((tokens / window) * 100).toFixed(1)}%/${windowText}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  }
  if (tokens < 10_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  if (tokens < 10_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000_000)}M`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
