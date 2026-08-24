import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getOpencodeFreeModels } from "./opencode-free";

/**
 * OpenCode Zen free-model provider. Uses a static model list — no startup
 * network fetch. Calls the Zen API directly; no valid API key needed.
 *
 * `apiKey: " "` (a space) satisfies the OpenAI SDK's auth requirement so
 * the framework marks the provider as "configured" (no `/login` needed).
 * The SDK sends `Authorization: Bearer  ` which Zen accepts for free models.
 */
export function registerHdwebsoftBackup(pi: ExtensionAPI): void {
  pi.registerProvider("hdwebsoft-backup", {
    name: "Model Backup Free",
    apiKey: " ",
    models: getOpencodeFreeModels(),
  });
}
