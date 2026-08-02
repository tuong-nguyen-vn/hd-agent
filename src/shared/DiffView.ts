import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import type { ToolDiff } from "./DiffLines";
import { DiffRenderer } from "./DiffRenderer";
import { Paths } from "./Paths";
import { type MarkerStatus, Renderer } from "./Renderer";

export type DiffStats = {
  readonly added: number;
  readonly removed: number;
};

export type DiffRenderState = {
  titleComponent?: Component;
  path?: string;
};

export class DiffView {
  public static countStats(diff: ToolDiff | undefined): DiffStats {
    if (!diff) {
      return { added: 0, removed: 0 };
    }

    let added = 0;
    let removed = 0;

    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added") {
          added += 1;
        } else if (line.kind === "removed") {
          removed += 1;
        }
      }
    }

    return { added, removed };
  }

  public static formatStats(stats: DiffStats, theme: Theme): string {
    const parts: string[] = [];

    if (stats.added > 0) {
      parts.push(theme.fg("toolDiffAdded", `+${stats.added}`));
    }

    if (stats.removed > 0) {
      parts.push(theme.fg("toolDiffRemoved", `-${stats.removed}`));
    }

    return parts.join(" ");
  }

  public static buildTitle(args: {
    readonly label: string;
    readonly path: string;
    readonly stats: DiffStats;
    readonly theme: Theme;
    readonly markerColor: MarkerStatus;
    readonly lastComponent: Component | undefined;
    readonly separator?: string;
    readonly markerGlyph?: string;
    readonly padTitle?: boolean;
    readonly executionStarted?: boolean;
    readonly invalidate?: () => void;
  }): Component {
    const { label, path, stats, theme, markerColor, lastComponent } = args;
    const statsText = DiffView.formatStats(stats, theme);

    return Renderer.renderToolCallTitle({
      label,
      title: statsText ? `${path} ${statsText}` : path,
      theme,
      context: {
        lastComponent,
        isPartial: markerColor === "warning",
        isError: markerColor === "error",
        executionStarted: args.executionStarted,
        invalidate: args.invalidate,
      },
      separator: args.separator,
      markerGlyph: args.markerGlyph,
      pad: args.padTitle,
      useSpinner: args.invalidate !== undefined,
    });
  }

  public static buildBlock(args: {
    readonly diff: ToolDiff;
    readonly theme: Theme;
    readonly lastComponent: Component | undefined;
    readonly expanded: boolean;
    readonly previewLines: number;
  }): Container {
    const { diff, theme, lastComponent, expanded, previewLines } = args;
    const container =
      (lastComponent as Container | undefined) ?? new Container();
    container.clear();

    const body = DiffRenderer.render({ toolDiff: diff, theme });

    if (!body) {
      return container;
    }

    container.addChild(
      Renderer.makePrefixedBlock({
        text: DiffView.previewOrFull(body, expanded, previewLines, theme),
        theme,
        prefix: { prefix: "", width: 0 },
      })
    );

    container.invalidate();
    return container;
  }

  // Amp-style collapsed diff: keep only the last `previewLines` rendered
  // lines (tail-anchored, since edits/additions are usually most relevant
  // near the end of a large write) and mark omitted lines with the same
  // "⋯" separator used between hunks.
  private static previewOrFull(
    body: string,
    expanded: boolean,
    previewLines: number,
    theme: Theme
  ): string {
    if (expanded) {
      return body;
    }

    const lines = body.split("\n");
    if (lines.length <= previewLines) {
      return body;
    }

    return [theme.fg("muted", "   ⋯"), ...lines.slice(-previewLines)].join(
      "\n"
    );
  }

  public static renderDiffCall(args: {
    readonly label: string;
    readonly rawPath: string | undefined;
    readonly theme: Theme;
    readonly context: {
      readonly state: DiffRenderState;
      readonly cwd: string;
      readonly isPartial: boolean;
      readonly isError: boolean;
      readonly lastComponent: Component | undefined;
      readonly executionStarted?: boolean;
      readonly invalidate?: () => void;
    };
    readonly separator?: string;
    readonly markerGlyph?: (markerColor: MarkerStatus) => string;
    readonly link?: boolean;
    readonly clickableLink?: boolean;
    readonly padTitle?: boolean;
  }): Component {
    const { label, rawPath, theme, context } = args;
    const state = context.state;
    const display = Paths.titleOr(rawPath, context.cwd);
    const styledPath =
      args.link && rawPath
        ? Renderer.renderFileLink(
            theme,
            display,
            Paths.resolve(rawPath, context.cwd),
            args.clickableLink
          )
        : display;
    state.path = styledPath;
    const markerColor = Renderer.markerColorFor(
      Boolean(context.isPartial),
      Boolean(context.isError)
    );
    const text = DiffView.buildTitle({
      label,
      path: styledPath,
      stats: { added: 0, removed: 0 },
      theme,
      markerColor,
      lastComponent: context.lastComponent,
      separator: args.separator,
      markerGlyph: args.markerGlyph?.(markerColor),
      padTitle: args.padTitle,
      executionStarted: context.executionStarted,
      invalidate: context.invalidate,
    });
    state.titleComponent = text;
    return text;
  }

  public static renderDiffResult(args: {
    readonly label: string;
    readonly result: AgentToolResult<unknown>;
    readonly options: ToolRenderResultOptions;
    readonly theme: Theme;
    readonly context: {
      readonly state: DiffRenderState;
      readonly isError: boolean;
      readonly lastComponent: Component | undefined;
      readonly invalidate?: () => void;
    };
    readonly previewLines: number;
    readonly diffPreviewLines: number;
    readonly separator?: string;
    readonly markerGlyph?: (markerColor: MarkerStatus) => string;
  }): Component {
    const {
      label,
      result,
      options,
      theme,
      context,
      previewLines,
      diffPreviewLines,
      separator,
      markerGlyph,
    } = args;
    const state = context.state;
    const fallback =
      (context.lastComponent as Container | undefined) ?? new Container();

    if (options.isPartial) {
      fallback.clear();
      return fallback;
    }

    if (context.isError) {
      if (state.titleComponent && state.path !== undefined) {
        const markerColor = Renderer.markerColorFor(false, true);
        DiffView.buildTitle({
          label,
          path: state.path,
          stats: { added: 0, removed: 0 },
          theme,
          markerColor,
          lastComponent: state.titleComponent,
          separator,
          markerGlyph: markerGlyph?.(markerColor),
        });
      }
      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context: { ...context, isPartial: false },
        previewLines,
      });
    }

    const details = result.details as { readonly diff?: ToolDiff } | undefined;
    const diff = details?.diff;
    const stats = DiffView.countStats(diff);

    if (state.titleComponent && state.path !== undefined) {
      const markerColor = Renderer.markerColorFor(false, false);
      DiffView.buildTitle({
        label,
        path: state.path,
        stats,
        theme,
        markerColor,
        lastComponent: state.titleComponent,
        separator,
        markerGlyph: markerGlyph?.(markerColor),
      });
    }

    if (!diff) {
      fallback.clear();
      return fallback;
    }

    return DiffView.buildBlock({
      diff,
      theme,
      lastComponent: context.lastComponent,
      expanded: options.expanded,
      previewLines: diffPreviewLines,
    });
  }
}
