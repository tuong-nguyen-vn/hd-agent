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

export type FooterStats = {
  readonly cost: number;
  readonly contextText: string;
};

type AmpEditorOptions = {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly getGitState: () => GitState;
  readonly getStats: () => FooterStats;
  readonly initialHistory: readonly string[];
};

const MIN_INPUT_LINES = 3;
// Below this the status label reads as noise; the bare spinner is used instead.
const MIN_STATUS_WIDTH = 12;

// Pi does not export WorkingStatusIndicator, so derive it from the base class
// to keep the override in step with pi's signature.
type WorkingStatusIndicator = NonNullable<
  Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]
>;

export function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  middle = ""
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
  const middleWidth = visibleWidth(middle);
  // The middle label is the editor's scroll marker: drop it rather than
  // squeeze the labels that frame it.
  if (middleWidth > 0 && gap >= middleWidth + 1) {
    const before = Math.floor((gap - middleWidth) / 2);
    const after = gap - middleWidth - before;
    return `${border("─")}${leftText}${border("─".repeat(before))}${middle}${border("─".repeat(after))}${rightText}${border("─")}`;
  }
  return `${border("─")}${leftText}${border("─".repeat(gap))}${rightText}${border("─")}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatContext(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
  if (!usage || !contextWindow || usage.percent === null) {
    return "? of context";
  }
  return `${Math.round(usage.percent)}% of ${formatTokens(contextWindow)}`;
}

function scrollMarker(
  theme: Theme,
  arrow: string,
  hiddenLineCount: number
): string {
  // Pi spells this "↑ N more", but both ends of this border already carry
  // labels — the compact form still fits between them at typical widths.
  return hiddenLineCount > 0
    ? theme.fg("muted", ` ${arrow} ${hiddenLineCount} `)
    : "";
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
  private workingStatus: WorkingStatusIndicator | undefined;

  public constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly options: AmpEditorOptions
  ) {
    // embedWorkingStatus makes pi hand the streaming indicator to this editor
    // instead of stacking it above; renderTopBorder() places it.
    super(tui, theme, keybindings, { paddingX: 1, embedWorkingStatus: true });
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

  public override setWorkingStatusIndicator(
    indicator: WorkingStatusIndicator | undefined
  ): void {
    super.setWorkingStatusIndicator(indicator);
    this.workingStatus = indicator;
  }

  protected override renderTopBorder(
    width: number,
    hiddenLineCount: number
  ): string {
    const { ctx, pi } = this.options;
    const theme = ctx.ui.theme;
    const model =
      ctx.model && ctx.model.provider
        ? `${ctx.model.provider}/${ctx.model.id}`
        : (ctx.model?.id ?? "no model");
    const level = pi.getThinkingLevel();
    const right =
      theme.fg("success", ` ${level} `) + theme.fg("muted", `${model} `);
    // Cost/context scan the whole session — served from an event-invalidated
    // cache so typing does no per-keystroke session walks.
    const left =
      this.renderWorkingStatus(width, visibleWidth(right)) ??
      theme.fg("muted", ` ${this.options.getStats().contextText} `);

    return fitBorder(
      left,
      right,
      width,
      (text) => this.borderColor(text),
      scrollMarker(theme, "↑", hiddenLineCount)
    );
  }

  protected override renderBottomBorder(
    width: number,
    hiddenLineCount: number
  ): string {
    const { ctx } = this.options;
    const theme = ctx.ui.theme;
    const stats = this.options.getStats();
    const path = Paths.abbreviateHome(ctx.sessionManager.getCwd());
    const git = formatGit(this.options.getGitState(), theme);

    const left =
      stats.cost > 0 ? theme.fg("muted", ` $${stats.cost.toFixed(2)} `) : "";
    const right = theme.fg("muted", ` ${path}`) + git + theme.fg("muted", " ");

    return fitBorder(
      left,
      right,
      width,
      (text) => this.borderColor(text),
      scrollMarker(theme, "↓", hiddenLineCount)
    );
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
    return lines;
  }

  // Full label when it fits beside the model chip, bare spinner otherwise, so
  // the top border never drops the model to make room for the status.
  private renderWorkingStatus(
    width: number,
    rightWidth: number
  ): string | undefined {
    const status = this.workingStatus;
    if (!status) {
      return undefined;
    }
    const budget = width - rightWidth - 5;
    if (budget >= MIN_STATUS_WIDTH) {
      const label = status.renderInBorder(budget);
      if (visibleWidth(label) > 0) {
        return ` ${label} `;
      }
    }
    const spinner = status.renderSpinnerInBorder(
      Math.max(0, width - rightWidth - 4)
    );
    return visibleWidth(spinner) > 0 ? ` ${spinner} ` : undefined;
  }
}
