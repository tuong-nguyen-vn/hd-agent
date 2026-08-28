import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * Static OpenCode Zen free-model list.
 *
 * Previously fetched from `https://opencode.ai/zen/v1/models` at every startup
 * (~840ms blocking network request). Replaced with a fixed list to eliminate
 * the startup network dependency. Update this list manually when Zen adds or
 * retires free models.
 */

const ZEN_API_ROOT = "https://opencode.ai/zen/v1";

/** Only `high` is selectable; everything else is turned off in the picker. */
const FREE_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: null,
} as const;

const FREE_MODEL_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens" as const,
} as const;

type FreeModelSpec = {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
};

const FREE_MODELS: readonly FreeModelSpec[] = [
  {
    id: "deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash",
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
  {
    id: "mimo-v2.5-free",
    name: "MiMo v2.5",
    contextWindow: 200_000,
    maxTokens: 128_000,
  },
];

export function getOpencodeFreeModels(): ProviderModelConfig[] {
  return FREE_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    api: "openai-completions",
    baseUrl: ZEN_API_ROOT,
    reasoning: true,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    thinkingLevelMap: FREE_THINKING_LEVEL_MAP,
    compat: FREE_MODEL_COMPAT,
  }));
}
