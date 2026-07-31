import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchOpencodeFreeModels } from "./opencode-free";

/**
 * OpenCode Zen free-model provider. Models are fetched dynamically at
 * startup from `https://opencode.ai/zen/v1/models` and call the Zen API
 * directly — no valid API key needed.
 *
 * `apiKey: "free"` makes the framework mark the provider as "configured"
 * (no `/login` prompt). The OpenAI SDK would normally send
 * `Authorization: Bearer free`, which Zen rejects (401). We override the
 * header to an empty string via provider-level `headers`; Zen accepts an
 * empty Authorization and serves the free models without auth.
 */
export async function registerHdwebsoftBackup(pi: ExtensionAPI): Promise<void> {
  const freeModels = await fetchOpencodeFreeModels();

  pi.registerProvider("hdwebsoft-backup", {
    name: "HDWEBSOFT Backup",
    apiKey: "free",
    headers: { Authorization: "" },
    models: freeModels,
  });
}
