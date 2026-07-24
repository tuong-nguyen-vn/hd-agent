import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

const TUONGNGUYEN_PROXY_ROOT = "https://proxy.tuongnguyen.work";
const HDWEBSOFT_PROXY_ROOT = "https://proxy-api.hdwebsoft.co";

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerProvider("tuongnguyen-proxy", {
    name: "Tuong Nguyen Proxy",
    authHeader: true,
    models: [
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        api: "anthropic-messages",
        baseUrl: TUONGNGUYEN_PROXY_ROOT,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 1000000,
        maxTokens: 128000,
        thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
        compat: {
          forceAdaptiveThinking: true,
          supportsTemperature: false
        },
      },
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        api: "anthropic-messages",
        baseUrl: TUONGNGUYEN_PROXY_ROOT,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 1000000,
        maxTokens: 128000,
        thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
        compat: { forceAdaptiveThinking: true },
      },
      {
        id: "glm-5.2",
        name: "GLM 5.2",
        api: "anthropic-messages",
        baseUrl: TUONGNGUYEN_PROXY_ROOT,
        reasoning: true,
        input: ["text"],
        cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 131072,
        thinkingLevelMap: {
          minimal: null,
          low: "high",
          medium: "high",
          high: "high",
          max: "max",
        },
        compat: { forceAdaptiveThinking: true },
      },
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        api: "openai-completions",
        baseUrl: `${TUONGNGUYEN_PROXY_ROOT}/v1`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
        contextWindow: 500000,
        maxTokens: 500000,
        thinkingLevelMap: { off: null, minimal: null },
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        api: "openai-completions",
        baseUrl: `${TUONGNGUYEN_PROXY_ROOT}/v1`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 272000,
        maxTokens: 128000,
        thinkingLevelMap: {
          off: "none",
          minimal: null,
          xhigh: "xhigh",
          max: "max",
        },
      },
      {
        id: "gpt-image-2",
        name: "GPT Image 2",
        api: "openai-completions",
        baseUrl: `${TUONGNGUYEN_PROXY_ROOT}/v1`,
        reasoning: false,
        input: ["image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 128000,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
        },
      },
      {
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        api: "google-generative-ai",
        baseUrl: `${TUONGNGUYEN_PROXY_ROOT}/v1beta`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
        thinkingLevelMap: { off: null },
      },
    ],
  });

  pi.registerProvider("hdwebsoft-proxy", {
    name: "HDWEBSOFT Proxy",
    authHeader: true,
    models: [
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        api: "anthropic-messages",
        baseUrl: HDWEBSOFT_PROXY_ROOT,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 300000,
        maxTokens: 128000,
        thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
        compat: {
          forceAdaptiveThinking: true,
          supportsTemperature: false
        },
      },
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        api: "anthropic-messages",
        baseUrl: HDWEBSOFT_PROXY_ROOT,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 300000,
        maxTokens: 128000,
        thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
        compat: { forceAdaptiveThinking: true },
      },
      {
        id: "gemini-3.6-flash",
        name: "Gemini 3.6 Flash",
        api: "google-generative-ai",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1beta`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
        thinkingLevelMap: { off: null },
      },
      {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro",
        api: "google-generative-ai",
        baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1beta`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "LOW",
          medium: null,
          high: "HIGH",
        },
      },
    ],
  });
}
