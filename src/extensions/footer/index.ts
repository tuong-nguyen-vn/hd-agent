import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { PimSettings } from "../../shared/PimSettings";
import { PromptHistory } from "../../shared/PromptHistory";
import { StartupRender } from "../../shared/StartupRender";
import { EMPTY_GIT, fetchGitStatus, watchGitDir } from "./git";

let activeGitRefresh: (() => void) | null = null;
let activeStatsInvalidate: (() => void) | null = null;
let activeChromeCleanup: (() => void) | null = null;

const GIT_REFRESH_DEBOUNCE_MS = 1_000;

export function getTotalCost(ctx: ExtensionContext): number {
  let cost = 0;
  for (const e of ctx.sessionManager.getEntries()) {
    if (e.type === "message" && e.message.role === "assistant") {
      cost += (e.message as AssistantMessage).usage.cost.total;
    }
  }
  return cost;
}

async function installAmpChrome(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }
  activeChromeCleanup?.();

  const { AmpEditor, formatContext } = await import("./AmpEditor");
  const initialHistory = await PromptHistory.load();

  // Cost/context walk every session entry — O(entries) per call. The editor
  // renders on every keystroke, so serve both from a cache invalidated on
  // session-mutating events instead of recomputing per render.
  let statsCache: { cost: number; contextText: string } | null = null;
  const getStats = (): { cost: number; contextText: string } => {
    statsCache ??= {
      cost: getTotalCost(ctx),
      contextText: formatContext(ctx),
    };
    return statsCache;
  };
  activeStatsInvalidate = () => {
    statsCache = null;
  };

  let gitState = EMPTY_GIT;
  let activeTui: TUI | undefined;
  // `git status` spawns a subprocess (100ms+ on large repos), and both the
  // .git watcher and tool_execution_end can fire per tool call. Share one
  // debounce across both triggers, never run two fetches concurrently, and
  // coalesce triggers that arrive mid-fetch into a single trailing refresh.
  let fetchInFlight = false;
  let refreshQueued = false;
  const refresh = async (): Promise<void> => {
    if (fetchInFlight) {
      refreshQueued = true;
      return;
    }
    fetchInFlight = true;
    try {
      gitState = await fetchGitStatus(ctx.cwd);
      activeTui?.requestRender();
    } finally {
      fetchInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  };
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh();
    }, GIT_REFRESH_DEBOUNCE_MS);
  };
  const disposeGitWatch = watchGitDir(ctx.cwd, scheduleRefresh);
  activeGitRefresh = scheduleRefresh;
  void refresh();

  ctx.ui.setFooter(() => ({
    render: () => [],
    invalidate() {},
  }));
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    activeTui = tui;
    // Release without passing the Proxy — release() uses the real TUI
    // captured during blocked requestRender calls, which is more reliable.
    setTimeout(() => StartupRender.release(), 0);
    return new AmpEditor(tui, theme, keybindings, {
      pi,
      ctx,
      getGitState: () => gitState,
      getStats,
      initialHistory,
    });
  });

  activeChromeCleanup = () => {
    disposeGitWatch();
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    activeGitRefresh = null;
    activeStatsInvalidate = null;
    activeTui = undefined;
    activeChromeCleanup = null;
  };
}

export default function (pi: ExtensionAPI): void {
  const apply = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      return;
    }
    const { enabled } = await PimSettings.get("powerline");
    if (enabled) {
      await installAmpChrome(pi, ctx);
    } else {
      activeChromeCleanup?.();
      ctx.ui.setFooter(undefined);
      ctx.ui.setEditorComponent(undefined);
      StartupRender.release();
    }
  };

  // Re-arm the preload render-suppression before pi tears down the current
  // session and renders its default editor. session_before_switch fires
  // before resetExtensionUI()/renderCurrentSessionState(), while session_start
  // fires only after the default UI has already been rendered.
  pi.on("session_before_switch", (event) => {
    if (event.reason === "new") {
      StartupRender.suppress();
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    await apply(ctx);
  });

  pi.on("tool_execution_end", () => {
    activeGitRefresh?.();
  });

  // Any event that lands a message, changes the branch, or swaps the model
  // can move cost/context; invalidate so the next render recomputes.
  const invalidateStats = (): void => {
    activeStatsInvalidate?.();
  };
  pi.on("message_end", invalidateStats);
  pi.on("agent_start", invalidateStats);
  pi.on("agent_end", invalidateStats);
  pi.on("session_compact", invalidateStats);
  pi.on("session_tree", invalidateStats);
  pi.on("model_select", invalidateStats);

  pi.on("session_shutdown", () => {
    activeChromeCleanup?.();
  });
}
