import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHdwebsoftProxy } from "./hdwebsoft-proxy";
import { registerHdwebsoftBackup } from "./opencode-zen";
import { registerTuongNguyenProxy } from "./tuongnguyen-proxy";

/**
 * Registers proxy providers via `pi.registerProvider()` instead of
 * `~/.pi/agent/models.json`. Unlike models.json (one `baseUrl` + `api` per
 * provider), `registerProvider`'s per-model `api` + `baseUrl` overrides let
 * one provider mix wire formats — each model talks to its proxy using its
 * vendor's native protocol/path (Anthropic `/v1/messages`, OpenAI
 * `/v1/chat/completions`, Google `/v1beta/models/...`) instead of being
 * flattened through a single OpenAI-compatible passthrough.
 *
 * No `apiKey` is set for either provider, so `/login <provider>` prompts
 * for a key and stores it in `~/.pi/agent/auth.json`, same as any built-in
 * provider.
 */
export default function (pi: ExtensionAPI): void {
  registerTuongNguyenProxy(pi);
  registerHdwebsoftProxy(pi);
  registerHdwebsoftBackup(pi);
}
