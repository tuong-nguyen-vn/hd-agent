import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

type DevinAuthExtension = (pi: ExtensionAPI) => Promise<void> | void;

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
const DEVIN_MODEL_ALLOWLIST = new Set<string>(["glm-5-2", "swe-1-7"]);

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
 * Wrap `pi.registerProvider` so any call registering the "devin" provider
 * (pi-devin-auth calls this once with fallback models, then again after
 * login/session_start with the live Cognition catalog) gets its `models`
 * filtered down to {@link DEVIN_MODEL_ALLOWLIST} and stamped with
 * {@link DEVIN_MODEL_OVERRIDES}. Calls for any other provider id pass
 * through untouched.
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
