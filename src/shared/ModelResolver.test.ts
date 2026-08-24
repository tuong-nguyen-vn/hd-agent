import { describe, expect, test } from "bun:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelResolver } from "./ModelResolver";

function makeModel(
  provider: string,
  id: string,
  overrides: Partial<Model<Api>> = {}
): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: `https://${provider}.example.com/v1`,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...overrides,
  } as Model<Api>;
}

function makeRegistry(
  models: readonly Model<Api>[],
  authedProviders: ReadonlySet<string>,
  apiKeyFor: (provider: string) => string | undefined = (p) =>
    authedProviders.has(p) ? `key-${p}` : undefined
): ModelRegistry {
  return {
    getAll: () => [...models],
    hasConfiguredAuth: (m: Model<Api>) => authedProviders.has(m.provider),
    getApiKeyAndHeaders: async (m: Model<Api>) => {
      const key = apiKeyFor(m.provider);
      if (!key) {
        return { ok: false, error: `No API key found for "${m.provider}"` };
      }
      return { ok: true, apiKey: key, headers: undefined };
    },
  } as unknown as ModelRegistry;
}

describe("ModelResolver.resolveReference", () => {
  const google = makeModel("google", "gemini-flash", {
    api: "google-generative-ai",
  });
  const proxy = makeModel("proxy", "gemini-flash");
  const openai = makeModel("openai", "gpt-4o");

  test("provider/model canonical match returns only that model", () => {
    const registry = makeRegistry([google, proxy, openai], new Set(["google"]));
    expect(
      ModelResolver.resolveReference(registry, "proxy/gemini-flash")
    ).toEqual([proxy]);
  });

  test("canonical match is case-insensitive", () => {
    const registry = makeRegistry([google, proxy, openai], new Set(["google"]));
    expect(
      ModelResolver.resolveReference(registry, "GOOGLE/GEMINI-FLASH")
    ).toEqual([google]);
  });

  test("bare id matches across providers, authenticated first, current provider first", () => {
    const registry = makeRegistry(
      [google, proxy, openai],
      new Set(["google", "proxy"])
    );
    const candidates = ModelResolver.resolveReference(
      registry,
      "gemini-flash",
      "proxy"
    );
    // proxy is current provider and authenticated -> first; google authenticated -> second
    expect(candidates).toEqual([proxy, google]);
  });

  test("bare id with no authenticated providers returns all matches", () => {
    const registry = makeRegistry([google, proxy], new Set([]));
    const candidates = ModelResolver.resolveReference(
      registry,
      "gemini-flash",
      "google"
    );
    expect(candidates).toEqual([google, proxy]);
  });

  test("unknown reference returns empty list", () => {
    const registry = makeRegistry([google], new Set(["google"]));
    expect(ModelResolver.resolveReference(registry, "missing-model")).toEqual(
      []
    );
  });
});

describe("ModelResolver.resolveCandidates", () => {
  const geminiFlash = makeModel("proxy", "gemini-3.7-flash");
  const swe = makeModel("devin", "glm-5-3", { input: ["text"] });

  test("comma-separated references are tried in declared order, deduped", async () => {
    const registry = makeRegistry(
      [geminiFlash, swe],
      new Set(["proxy", "devin"])
    );
    const candidates = await ModelResolver.resolveCandidates(
      registry,
      "gemini-3.7-flash, glm-5-3"
    );
    expect(candidates).toEqual([geminiFlash, swe]);
  });

  test("duplicate provider/model across references is deduped", async () => {
    const registry = makeRegistry([geminiFlash], new Set(["proxy"]));
    const candidates = await ModelResolver.resolveCandidates(
      registry,
      "gemini-3.7-flash, proxy/gemini-3.7-flash"
    );
    expect(candidates).toEqual([geminiFlash]);
  });

  test("empty reference string yields no candidates", async () => {
    const registry = makeRegistry([geminiFlash], new Set(["proxy"]));
    expect(await ModelResolver.resolveCandidates(registry, "")).toEqual([]);
  });

  test("whitespace-only entries are skipped", async () => {
    const registry = makeRegistry([geminiFlash], new Set(["proxy"]));
    const candidates = await ModelResolver.resolveCandidates(
      registry,
      "  , gemini-3.7-flash , "
    );
    expect(candidates).toEqual([geminiFlash]);
  });
});

describe("ModelResolver.resolveAuth", () => {
  const model = makeModel("openai", "gpt-4o");

  test("resolves apiKey from registry", async () => {
    const registry = makeRegistry([model], new Set(["openai"]));
    const resolved = await ModelResolver.resolveAuth(registry, model);
    expect(resolved.model).toBe(model);
    expect(resolved.apiKey).toBe("key-openai");
    expect(resolved.headers).toBeUndefined();
  });

  test("throws when provider has no configured auth", async () => {
    const registry = makeRegistry([model], new Set([]));
    await expect(ModelResolver.resolveAuth(registry, model)).rejects.toThrow(
      'No API key found for "openai"'
    );
  });
});
