import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  EditorTheme,
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ActivityLine } from "../../shared/ActivityLine";
import { JournalLine } from "../../shared/JournalLine";
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
  private activityStart = -1;
  private activityEnd = -1;
  private journalStart = -1;
  private journalEnd = -1;

  public constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly options: AmpEditorOptions
  ) {
    // embedWorkingStatus makes pi hand the streaming indicator to this editor
    // instead of stacking it above; renderTopBorder() places it.
    super(tui, theme, keybindings, { paddingX: 1, embedWorkingStatus: true });
    // The caption is updated from session events outside the editor; give
    // it a way to repaint the border when the text changes.
    ActivityLine.setRenderTrigger(() => tui.requestRender());
    JournalLine.setRenderTrigger(() => tui.requestRender());
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

    const cost =
      stats.cost > 0 ? theme.fg("muted", ` $${stats.cost.toFixed(2)} `) : "";
    const activity = ActivityLine.getText();
    // Keep the caption short; explicit ellipsis marks truncation (the
    // border itself would otherwise cut silently).
    const caption = activity
      ? truncateToWidth(activity, Math.max(0, width - 40), "…")
      : undefined;
    const left = caption ? `${cost}${theme.fg("dim", ` ${caption} `)}` : cost;
    // Click range for the caption: 1 space after the leading border, then
    // the cost text, then a space before the caption itself.
    this.activityStart = activity ? visibleWidth(cost) + 2 : -1;
    this.activityEnd = activity ? visibleWidth(left) - 2 : -1;
    const journal = JournalLine.getText();
    const journalText = journal ? theme.fg("dim", ` ${journal} `) : "";
    const right =
      journalText +
      theme.fg("muted", ` ${path}`) +
      git +
      theme.fg("muted", " ");
    // Click range for the memory indicator: it sits at the far right of the
    // bottom border, before the path. Compute from the end since the border
    // right-aligns the whole segment.
    if (journal) {
      // fitBorder places the right segment at [width-1-rightWidth, width-2]
      // with a trailing corner cell at width-1; the journal label is the
      // segment's first piece, before any truncation affects the path.
      const journalWidth = visibleWidth(journalText);
      this.journalStart = width - 1 - visibleWidth(right);
      this.journalEnd = this.journalStart + journalWidth - 1;
    } else {
      this.journalStart = -1;
      this.journalEnd = -1;
    }

    return fitBorder(
      left,
      right,
      width,
      (text) => this.borderColor(text),
      scrollMarker(theme, "↓", hiddenLineCount)
    );
  }

  public override handleMouse(
    event: TuiMouseEvent
  ): TuiMouseEventResult | undefined {
    // The activity caption sits in the bottom border (last rendered row).
    if (
      event.type === "click" &&
      event.button === "left" &&
      event.y === event.height - 1
    ) {
      if (
        this.activityStart >= 0 &&
        event.x >= this.activityStart &&
        event.x <= this.activityEnd
      ) {
        ActivityLine.open();
        return { handled: true };
      }
      if (
        this.journalStart >= 0 &&
        event.x >= this.journalStart &&
        event.x <= this.journalEnd
      ) {
        JournalLine.toggle();
        return { handled: true };
      }
    }
    return super.handleMouse(event);
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
