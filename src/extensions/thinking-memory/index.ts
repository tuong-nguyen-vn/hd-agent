import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PimSettings } from "../../shared/PimSettings";

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * When switching models, pi's core (AgentSession#_getThinkingLevelForModelSwitch
 * in @earendil-works/pi-coding-agent) carries the *current* thinking level
 * forward and re-clamps it for the new model's capabilities — it has no
 * memory of what level was last used on a given model. So cycling
 * claude-sonnet-5 (high) -> swe-1-7 (clamped to off, since it exposes no
 * levels) -> claude-sonnet-5 comes back as "off" instead of "high".
 *
 * This extension remembers the last thinking level explicitly selected per
 * model — persisted to `~/.pim/settings.json` via `PimSettings` so it
 * survives restarts — and restores it whenever the user switches back to
 * that model. Persisted writes only happen on explicit level changes (a rare,
 * user-driven action); model switches only read the in-memory copy, so no
 * disk I/O sits on that hot path.
 */
export default async function registerThinkingMemory(
  pi: ExtensionAPI
): Promise<void> {
  const persisted = await PimSettings.getThinkingLevels();
  const lastLevelByModel = new Map<string, ThinkingLevel>(
    Object.entries(persisted) as [string, ThinkingLevel][]
  );

  pi.on("thinking_level_select", async (event, ctx) => {
    if (!ctx.model) {
      return;
    }
    const key = modelKey(ctx.model);
    lastLevelByModel.set(key, event.level);
    await PimSettings.setThinkingLevel(key, event.level);
  });

  pi.on("model_select", (event) => {
    const remembered = lastLevelByModel.get(modelKey(event.model));
    if (remembered !== undefined && remembered !== pi.getThinkingLevel()) {
      pi.setThinkingLevel(remembered);
    }
  });
}
