import type {
  AssistantMessageEventStream,
  Model,
  Api,
  Context,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

type DevinAuthExtension = (pi: ExtensionAPI) => Promise<void> | void;

type StreamSimpleFn = NonNullable<
  Parameters<ExtensionAPI["registerProvider"]>[1] extends infer C
    ? C extends { streamSimple?: infer F }
      ? F
      : never
    : never
>;

const DEVIN_PROVIDER_ID = "devin";

/**
 * pi-devin-auth's live catalog includes every reasoning-effort variant
 * Cognition exposes for each model family, e.g. for `glm-5-2`: `glm-5-2`
 * ("GLM-5.2 High"), `glm-5-2-max`, `glm-5-2-1m`, `glm-5-2-max-1m`,
 * `glm-5-2-none`, `glm-5-2-none-1m`; for `swe-1-7`: `swe-1-7` ("SWE-1.7
 * Max" — the unsuffixed id IS the max-effort variant), `swe-1-7-lightning`,
 * `swe-1-7-medium`. Confirmed via a direct `getCachedCatalog()` dump against
 * the live Cognition API (`GetCascadeModelConfigs`). Keep only the base ids.
 */
const DEVIN_MODEL_ALLOWLIST = new Set<string>([
  "glm-5-2",
  "swe-1-7",
  "claude-sonnet-5-high",
]);

/**
 * pi-devin-auth stamps every variant of a family with the SAME
 * contextWindow/maxTokens (see its MODEL_META prefix table), which doesn't
 * always match what we actually want for a given variant, and doesn't set
 * `thinkingLevelMap` at all. Override here.
 *
 * Note: pi-devin-auth's `streamDevin()` never reads pi's selected thinking
 * level — Cognition's effort tiers are baked into the model_uid itself
 * (`glm-5-2` = High, `swe-1-7` = Max), not a runtime parameter. These
 * `thinkingLevelMap`s only control what shows in pi's thinking-level
 * picker; they don't change what's sent over the wire.
 */
const DEVIN_MODEL_OVERRIDES: Record<
  string,
  Partial<
    Pick<
      ProviderModelConfig,
      "contextWindow" | "maxTokens" | "thinkingLevelMap"
    >
  >
> = {
  "glm-5-2": {
    contextWindow: 200_000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    },
  },
  "swe-1-7": {
    contextWindow: 262_144,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: "max",
    },
  },
  "claude-sonnet-5-high": {
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    },
  },
};

function filterDevinModels(
  models: ProviderModelConfig[] | undefined
): ProviderModelConfig[] | undefined {
  if (!models) {
    return models;
  }
  return models
    .filter((model) => DEVIN_MODEL_ALLOWLIST.has(model.id))
    .map((model) => ({ ...model, ...DEVIN_MODEL_OVERRIDES[model.id] }));
}

/**
 * Wrap a devin `streamSimple` so the final assistant message's
 * `usage.totalTokens` reflects the full context window occupancy
 * (input + cacheRead + cacheWrite + output) instead of pi-devin-auth's
 * input+output-only total. pi's context-usage bar reads `totalTokens`
 * when truthy; without cacheRead it stays pinned at ~0% on long cached
 * conversations (e.g. 73K cached tokens counted as 653).
 */
function wrapDevinStreamSimple(
  streamSimple: StreamSimpleFn | undefined
): StreamSimpleFn | undefined {
  if (!streamSimple) {
    return streamSimple;
  }
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream => {
    const upstream = streamSimple(model, context, options);
    const out = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const ev of upstream) {
          if (ev.type === "done" || ev.type === "error") {
            const msg = ev.type === "done" ? ev.message : ev.error;
            const u = msg.usage;
            if (u && u.totalTokens <= u.input + u.output) {
              u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
            }
          }
          out.push(ev);
        }
        out.end();
      } catch (err) {
        out.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "error",
            timestamp: Date.now(),
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        out.end();
      }
    })();
    return out;
  };
}

/**
 * Wrap `pi.registerProvider` so any call registering the "devin" provider
 * (pi-devin-auth calls this once with fallback models, then again after
 * login/session_start with the live Cognition catalog) gets its `models`
 * filtered down to {@link DEVIN_MODEL_ALLOWLIST}, stamped with
 * {@link DEVIN_MODEL_OVERRIDES}, and its `streamSimple` wrapped by
 * {@link wrapDevinStreamSimple} to fix context-usage accounting.
 * Calls for any other provider id pass through untouched.
 */
function withDevinModelFilter(pi: ExtensionAPI): ExtensionAPI {
  const registerProvider = pi.registerProvider.bind(pi);
  const wrapped = Object.create(pi) as ExtensionAPI;
  wrapped.registerProvider = ((
    ...args: Parameters<ExtensionAPI["registerProvider"]>
  ) => {
    if (
      args.length === 2 &&
      typeof args[0] === "string" &&
      args[0] === DEVIN_PROVIDER_ID
    ) {
      const [name, config] = args;
      registerProvider(name, {
        ...config,
        models: filterDevinModels(config.models),
        streamSimple: wrapDevinStreamSimple(config.streamSimple),
      });
      return;
    }
    registerProvider(...args);
  }) as ExtensionAPI["registerProvider"];
  return wrapped;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const moduleName: string = "pi-devin-auth/extensions/index.js";
  const { default: devinAuth } = (await import(moduleName)) as {
    readonly default: DevinAuthExtension;
  };
  await devinAuth(withDevinModelFilter(pi));
}
