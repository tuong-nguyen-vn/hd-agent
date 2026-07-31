import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Dynamic OpenCode Zen free-model loader.
 *
 * The free-model list is fetched from OpenCode Zen's `/v1/models` at every
 * startup so newly added / retired free models are picked up without a code
 * change. Per-model metadata (context window, max output) is pulled from
 * models.dev's catalog (cached on disk for 7 days to avoid re-downloading
 * the 3.5MB catalog every session). Thinking is pinned to `high` only;
 * every other level is disabled.
 */

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const MODELS_DEV_CATALOG_URL = "https://models.dev/catalog.json";
const CACHE_FILE = join(
  homedir(),
  ".pi",
  "agent",
  ".cache",
  "opencode-free-meta.json"
);
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_CONTEXT = 200_000;
const DEFAULT_MAX_TOKENS = 32_000;

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

/** A model id is "free" on Zen if it ends with `-free` or is a known stealth
 * alias like `big-pickle` (routes to deepseek-v4-flash at $0). */
function isFreeModel(id: string): boolean {
  return id === "big-pickle" || id.endsWith("-free");
}

/** Strip "Free" and marketing suffixes like "(New)" from a display name so
 * the picker doesn't advertise models as free. Also tidies hyphens and
 * collapses leftover whitespace.
 *
 *   "DeepSeek V4 Flash Free (New)" → "DeepSeek V4 Flash"
 *   "Ling-3.0-flash Free"          → "Ling 3.0 Flash"
 *   "Big Pickle"                    → "Big Pickle" (unchanged)
 */
function cleanDisplayName(raw: string): string {
  return raw
    .replace(/\bFree\b/gi, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type FreeModelMeta = Record<
  string,
  { context: number; output: number; name?: string }
>;

/** Load free-model metadata from models.dev, using a 7-day disk cache to
 * avoid re-fetching the 3.5MB catalog on every session. Returns {} on any
 * failure so callers fall back to DEFAULT_CONTEXT / DEFAULT_MAX_TOKENS. */
async function loadFreeModelMeta(): Promise<FreeModelMeta> {
  // 1. Try fresh cache first.
  try {
    if (existsSync(CACHE_FILE)) {
      const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as {
        fetchedAt: number;
        models: FreeModelMeta;
      };
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.models;
      }
    }
  } catch {
    // Corrupt cache — ignore and re-fetch.
  }

  // 2. Fetch fresh catalog and extract free models only.
  try {
    const catalog = (await fetch(MODELS_DEV_CATALOG_URL).then((r) =>
      r.json()
    )) as {
      providers?: { opencode?: { models?: Record<string, any> } };
    };
    const opencodeModels = catalog?.providers?.opencode?.models ?? {};
    const meta: FreeModelMeta = {};
    for (const [id, m] of Object.entries(opencodeModels)) {
      if (m?.cost?.input === 0 && m?.cost?.output === 0) {
        meta[id] = {
          context: m?.limit?.context ?? DEFAULT_CONTEXT,
          output: m?.limit?.output ?? DEFAULT_MAX_TOKENS,
          name: m?.name,
        };
      }
    }
    // 3. Persist cache.
    try {
      mkdirSync(join(homedir(), ".pi", "agent", ".cache"), { recursive: true });
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({ fetchedAt: Date.now(), models: meta })
      );
    } catch {
      // Non-fatal: caching is best-effort.
    }
    return meta;
  } catch {
    return {};
  }
}

/** Fetch the current free-model list from Zen and merge with metadata from
 * models.dev. Models unknown to models.dev fall back to 200K / 32K. */
export async function fetchOpencodeFreeModels(
  proxyRoot: string
): Promise<ProviderModelConfig[]> {
  let freeIds: string[] = [];
  try {
    const list = (await fetch(ZEN_MODELS_URL).then((r) => r.json())) as {
      data?: { id: string }[];
    };
    freeIds = (list?.data ?? []).map((m) => m.id).filter(isFreeModel);
  } catch {
    // Network failure — register no free models rather than stale guesses.
    return [];
  }

  const meta = await loadFreeModelMeta();
  return freeIds.map((id) => {
    const m = meta[id];
    return {
      id,
      name: cleanDisplayName(m?.name ?? id),
      api: "openai-completions",
      baseUrl: `${proxyRoot}/v1`,
      reasoning: true,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m?.context ?? DEFAULT_CONTEXT,
      maxTokens: m?.output ?? DEFAULT_MAX_TOKENS,
      thinkingLevelMap: FREE_THINKING_LEVEL_MAP,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens" as const,
      },
    };
  });
}
