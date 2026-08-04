import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Paths } from "../../shared/Paths";
import { PromptHistory } from "../../shared/PromptHistory";
import type { GitState } from "./git";

const GIT_BRANCH_ICON = "\ue725";

type AmpEditorOptions = {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly getGitState: () => GitState;
  readonly getCost: () => number;
  readonly initialHistory: readonly string[];
};

const MIN_INPUT_LINES = 3;

export function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string
): string {
  if (width <= 0) {
    return "";
  }
  if (width === 1) {
    return border("─");
  }

  let leftText = left;
  let rightText = right;
  const fixedWidth = 2;
  const minimumGap = 3;
  let leftWidth = visibleWidth(leftText);
  let rightWidth = visibleWidth(rightText);
  let overflow = fixedWidth + leftWidth + rightWidth + minimumGap - width;

  if (overflow > 0 && rightWidth > 0) {
    rightText = truncateToWidth(
      rightText,
      Math.max(0, rightWidth - overflow),
      ""
    );
    rightWidth = visibleWidth(rightText);
    overflow = fixedWidth + leftWidth + rightWidth + minimumGap - width;
  }
  if (overflow > 0 && leftWidth > 0) {
    leftText = truncateToWidth(leftText, Math.max(0, leftWidth - overflow), "");
    leftWidth = visibleWidth(leftText);
  }

  const gap = Math.max(0, width - fixedWidth - leftWidth - rightWidth);
  return `${border("─")}${leftText}${border("─".repeat(gap))}${rightText}${border("─")}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatContext(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!usage || !contextWindow || usage.percent === null) {
    return "? of context";
  }
  return `${Math.round(usage.percent)}% of ${formatTokens(contextWindow)}`;
}

function formatGit(state: GitState, theme: Theme): string {
  if (!state.branch) {
    return "";
  }
  const branch = theme.fg("accent", `${GIT_BRANCH_ICON} ${state.branch}`);
  const status: string[] = [];
  if (state.dirty) {
    status.push("!");
  }
  if (state.ahead > 0) {
    status.push(`↑${state.ahead}`);
  }
  if (state.behind > 0) {
    status.push(`↓${state.behind}`);
  }
  const suffix =
    status.length > 0 ? ` ${theme.fg("muted", `[${status.join("")}]`)}` : "";
  return ` ${branch}${suffix}`;
}

export class AmpEditor extends CustomEditor {
  public constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly options: AmpEditorOptions
  ) {
    super(tui, theme, keybindings, { paddingX: 1 });
    // Seed prompt history from disk so up/down arrow navigation works across
    // sessions. Uses the base addToHistory() (not the override below) so this
    // replay doesn't immediately re-persist the same entries back to disk.
    for (const entry of options.initialHistory) {
      super.addToHistory(entry);
    }
  }

  public override addToHistory(text: string): void {
    super.addToHistory(text);
    PromptHistory.persist((this as unknown as { history: string[] }).history);
  }

  public override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 2) {
      return lines;
    }

    const missingInputLines = Math.max(0, MIN_INPUT_LINES - (lines.length - 2));
    if (missingInputLines > 0) {
      lines.splice(
        lines.length - 1,
        0,
        ...Array.from({ length: missingInputLines }, () => " ".repeat(width))
      );
    }

    const { ctx, pi } = this.options;
    const theme = ctx.ui.theme;
    const model =
      ctx.model && ctx.model.provider
        ? `${ctx.model.provider}/${ctx.model.id}`
        : (ctx.model?.id ?? "no model");
    const level = pi.getThinkingLevel();
    const cost = this.options.getCost();
    const path = Paths.abbreviateHome(ctx.sessionManager.getCwd());
    const git = formatGit(this.options.getGitState(), theme);
    const border = (text: string) => this.borderColor(text);

    const topLeft = theme.fg("muted", ` ${formatContext(ctx)} `);
    const topRight =
      theme.fg("success", ` ${level} `) + theme.fg("muted", `${model} `);
    const bottomLeft =
      cost > 0 ? theme.fg("muted", ` $${cost.toFixed(2)} `) : "";
    const bottomRight =
      theme.fg("muted", ` ${path}`) + git + theme.fg("muted", " ");

    lines[0] = fitBorder(topLeft, topRight, width, border);
    lines[lines.length - 1] = fitBorder(bottomLeft, bottomRight, width, border);
    return lines;
  }
}
