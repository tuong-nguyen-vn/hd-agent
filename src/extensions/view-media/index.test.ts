import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runVisionFallback } from "./index";

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

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  handler: (
    url: string,
    init?: RequestInit
  ) => {
    status: number;
    body: unknown;
  }
) {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body),
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response;
  }) as typeof fetch;
}

describe("runVisionFallback", () => {
  const base64 = "AAAA";
  const mimeType = "image/png";

  test("returns description from the first working candidate", async () => {
    const model = makeModel("openai", "gpt-4o");
    const registry = makeRegistry([model], new Set(["openai"]));
    mockFetch(() => ({
      status: 200,
      body: {
        choices: [
          {
            message: { content: "A red square" },
          },
        ],
      },
    }));

    const result = await runVisionFallback(
      registry,
      [model],
      base64,
      mimeType,
      100,
      "",
      undefined,
      "gpt-4o"
    );

    expect(result).toBeDefined();
    expect(result!.content[0]).toEqual({
      type: "text",
      text: "A red square",
    });
    expect(result!.details.source).toBe("vision-fallback");
    expect(result!.details.visionModel).toBe("gpt-4o");
  });

  test("falls back to the next candidate when the first errors", async () => {
    const bad = makeModel("openai", "bad-model");
    const good = makeModel("google", "gemini-flash", {
      api: "google-generative-ai",
    });
    const registry = makeRegistry([bad, good], new Set(["openai", "google"]));
    let calls = 0;
    mockFetch((url) => {
      calls++;
      if (url.includes("bad-model") || url.includes("/chat/completions")) {
        return { status: 500, body: "boom" };
      }
      return {
        status: 200,
        body: {
          candidates: [{ content: { parts: [{ text: "from gemini" }] } }],
        },
      };
    });

    const result = await runVisionFallback(
      registry,
      [bad, good],
      base64,
      mimeType,
      100,
      "",
      undefined,
      "bad-model, gemini-flash"
    );

    expect(result).toBeDefined();
    expect(result!.content[0]).toMatchObject({ text: "from gemini" });
    expect(result!.details.visionModel).toBe("gemini-flash");
    expect(calls).toBe(2);
  });

  test("skips candidates that do not accept image input", async () => {
    const textOnly = makeModel("openai", "text-only", { input: ["text"] });
    const vision = makeModel("openai", "gpt-4o");
    const registry = makeRegistry([textOnly, vision], new Set(["openai"]));
    let calls = 0;
    mockFetch(() => {
      calls++;
      return {
        status: 200,
        body: { choices: [{ message: { content: "ok" } }] },
      };
    });

    const result = await runVisionFallback(
      registry,
      [textOnly, vision],
      base64,
      mimeType,
      100,
      "",
      undefined,
      "text-only, gpt-4o"
    );

    expect(result).toBeDefined();
    expect(result!.details.visionModel).toBe("gpt-4o");
    // textOnly was skipped, only one fetch call
    expect(calls).toBe(1);
  });

  test("returns undefined when all candidates fail", async () => {
    const a = makeModel("openai", "a");
    const b = makeModel("openai", "b");
    const registry = makeRegistry([a, b], new Set(["openai"]));
    mockFetch(() => ({ status: 500, body: "err" }));

    const result = await runVisionFallback(
      registry,
      [a, b],
      base64,
      mimeType,
      100,
      "",
      undefined,
      "a, b"
    );

    expect(result).toBeUndefined();
  });

  test("returns undefined when no candidates are authenticated", async () => {
    const model = makeModel("openai", "gpt-4o");
    const registry = makeRegistry([model], new Set([]));
    let called = false;
    mockFetch(() => {
      called = true;
      return { status: 200, body: {} };
    });

    const result = await runVisionFallback(
      registry,
      [model],
      base64,
      mimeType,
      100,
      "",
      undefined,
      "gpt-4o"
    );

    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  test("returns undefined when there are no candidates", async () => {
    const registry = makeRegistry([], new Set());
    const result = await runVisionFallback(
      registry,
      [],
      base64,
      mimeType,
      100,
      "",
      undefined,
      "missing"
    );
    expect(result).toBeUndefined();
  });
});
