import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchOpencodeFreeModels } from "./opencode-free";

/**
 * OpenCode Zen free-model provider. Models are fetched dynamically at
 * startup from `https://opencode.ai/zen/v1/models` and call the Zen API
 * directly — no auth header sent, no real API key needed. A dummy
 * `apiKey` is set so the framework marks the provider as "configured"
 * without requiring `/login`.
 */
export async function registerHdwebsoftBackup(pi: ExtensionAPI): Promise<void> {
  const freeModels = await fetchOpencodeFreeModels();

  pi.registerProvider("hdwebsoft-backup", {
    name: "HDWEBSOFT Backup",
    apiKey: "free",
    models: freeModels,
  });
}
