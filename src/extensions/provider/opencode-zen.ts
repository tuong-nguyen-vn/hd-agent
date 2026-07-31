import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchOpencodeFreeModels } from "./opencode-free";

/**
 * OpenCode Zen free-model provider. Models are fetched dynamically at
 * startup from `https://opencode.ai/zen/v1/models` and call the Zen API
 * directly — no valid API key needed.
 *
 * `apiKey: " "` (a space) satisfies the OpenAI SDK's auth requirement so
 * the framework marks the provider as "configured" (no `/login` needed).
 * The SDK sends `Authorization: Bearer  ` which Zen accepts for free models.
 */
export async function registerHdwebsoftBackup(pi: ExtensionAPI): Promise<void> {
  const freeModels = await fetchOpencodeFreeModels();

  pi.registerProvider("hdwebsoft-backup", {
    name: "HDWEBSOFT Backup",
    apiKey: " ",
    models: freeModels,
  });
}
