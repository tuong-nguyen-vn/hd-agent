import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { PimSettings } from "../../shared/PimSettings";
import { PromptHistory } from "../../shared/PromptHistory";
import { StartupRender } from "../../shared/StartupRender";
import { AmpEditor } from "./AmpEditor";
import { EMPTY_GIT, fetchGitStatus, watchGitDir } from "./git";

let activeGitRefresh: (() => void) | null = null;
let activeChromeCleanup: (() => void) | null = null;

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

  const initialHistory = await PromptHistory.load();

  let gitState = EMPTY_GIT;
  let activeTui: TUI | undefined;
  const refresh = async (): Promise<void> => {
    const next = await fetchGitStatus(ctx.cwd);
    gitState = next;
    activeTui?.requestRender();
  };
  const disposeGitWatch = watchGitDir(ctx.cwd, () => {
    void refresh();
  });
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  activeGitRefresh = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh();
    }, 200);
  };
  void refresh();

  ctx.ui.setFooter(() => ({
    render: () => [],
    invalidate() {},
  }));
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    activeTui = tui;
    setTimeout(() => StartupRender.release(tui), 0);
    return new AmpEditor(tui, theme, keybindings, {
      pi,
      ctx,
      getGitState: () => gitState,
      getCost: () => getTotalCost(ctx),
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

  pi.on("session_shutdown", () => {
    activeChromeCleanup?.();
  });
}
