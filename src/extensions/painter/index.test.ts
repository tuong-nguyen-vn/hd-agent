import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runPainterFallback } from "./index";

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

describe("runPainterFallback", () => {
  test("generate: returns json from the first working candidate", async () => {
    const model = makeModel("openai", "gpt-image-2");
    const registry = makeRegistry([model], new Set(["openai"]));
    let calledUrl = "";
    mockFetch((url) => {
      calledUrl = url;
      return {
        status: 200,
        body: { data: [{ b64_json: "AAAA" }] },
      };
    });

    const result = await runPainterFallback(
      registry,
      [model],
      "generate",
      "a cat",
      [],
      "1024x1024",
      "medium",
      undefined
    );

    expect(result.json).toEqual({ data: [{ b64_json: "AAAA" }] });
    expect(result.usedModel).toBe("openai/gpt-image-2");
    expect(result.errors).toEqual([]);
    expect(calledUrl).toContain("/images/generations");
  });

  test("falls back to the next candidate when the first errors", async () => {
    const bad = makeModel("openai", "bad-image");
    const good = makeModel("proxy", "good-image");
    const registry = makeRegistry([bad, good], new Set(["openai", "proxy"]));
    let calls = 0;
    mockFetch((_url, init) => {
      calls++;
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("bad-image")) {
        return { status: 500, body: "boom" };
      }
      return { status: 200, body: { data: [{ b64_json: "BBBB" }] } };
    });

    const result = await runPainterFallback(
      registry,
      [bad, good],
      "generate",
      "a cat",
      [],
      "1024x1024",
      "medium",
      undefined
    );

    expect(result.json).toEqual({ data: [{ b64_json: "BBBB" }] });
    expect(result.usedModel).toBe("proxy/good-image");
    expect(result.errors).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test("returns undefined json when all candidates fail", async () => {
    const a = makeModel("openai", "a");
    const b = makeModel("openai", "b");
    const registry = makeRegistry([a, b], new Set(["openai"]));
    mockFetch(() => ({ status: 500, body: "err" }));

    const result = await runPainterFallback(
      registry,
      [a, b],
      "generate",
      "a cat",
      [],
      "1024x1024",
      "medium",
      undefined
    );

    expect(result.json).toBeUndefined();
    expect(result.usedModel).toBeUndefined();
    expect(result.errors).toHaveLength(2);
  });

  test("skips unauthenticated candidates without calling fetch", async () => {
    const model = makeModel("openai", "gpt-image-2");
    const registry = makeRegistry([model], new Set([]));
    let called = false;
    mockFetch(() => {
      called = true;
      return { status: 200, body: {} };
    });

    const result = await runPainterFallback(
      registry,
      [model],
      "generate",
      "a cat",
      [],
      "1024x1024",
      "medium",
      undefined
    );

    expect(result.json).toBeUndefined();
    expect(called).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("auth for");
  });

  test("returns undefined json when there are no candidates", async () => {
    const registry = makeRegistry([], new Set());
    const result = await runPainterFallback(
      registry,
      [],
      "generate",
      "a cat",
      [],
      "1024x1024",
      "medium",
      undefined
    );
    expect(result.json).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  test("generate: calls Google Interactions API for google-generative-ai models", async () => {
    const model = makeModel("hdwebsoft-proxy", "gemini-3.1-flash-image", {
      api: "google-generative-ai",
      baseUrl: "https://proxy-api.hdwebsoft.co/v1beta",
    });
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    let calledUrl = "";
    let postedBody: unknown;
    mockFetch((url, init) => {
      calledUrl = url;
      postedBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return {
        status: 200,
        body: {
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "image",
                  mime_type: "image/png",
                  data: "GGGG",
                },
              ],
            },
          ],
        },
      };
    });

    const result = await runPainterFallback(
      registry,
      [model],
      "generate",
      "a cat",
      [],
      "1024x1024",
      "medium",
      undefined
    );

    expect(calledUrl).toContain("/v1beta/interactions");
    expect(postedBody).toEqual({
      model: "gemini-3.1-flash-image",
      input: [{ type: "text", text: "a cat" }],
    });
    expect(result.json).toEqual({
      data: [{ b64_json: "GGGG", mime_type: "image/png" }],
    });
    expect(result.usedModel).toBe("hdwebsoft-proxy/gemini-3.1-flash-image");
  });

  test("edit: includes image input for Google Interactions API", async () => {
    const tmpPath = "/tmp/test-input.png";
    await Bun.write(tmpPath, Buffer.from("FAKEPNG", "base64"));

    const model = makeModel("hdwebsoft-proxy", "gemini-3.1-flash-image", {
      api: "google-generative-ai",
      baseUrl: "https://proxy-api.hdwebsoft.co/v1beta",
    });
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    let postedBody: unknown;
    mockFetch((_url, init) => {
      postedBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return {
        status: 200,
        body: {
          steps: [
            {
              type: "model_output",
              content: [{ type: "image", data: "EDITED" }],
            },
          ],
        },
      };
    });

    const result = await runPainterFallback(
      registry,
      [model],
      "edit",
      "make the cat wear a hat",
      [tmpPath],
      "1024x1024",
      "medium",
      undefined
    );

    expect(postedBody).toMatchObject({
      model: "gemini-3.1-flash-image",
      input: [
        { type: "text", text: "make the cat wear a hat" },
        { type: "image", mime_type: "image/png" },
      ],
    });
    expect((postedBody as any).input[1].data).toBeTruthy();
    expect(result.json).toEqual({
      data: [{ b64_json: "EDITED", mime_type: "image/png" }],
    });

    await Bun.file(tmpPath).delete();
  });

  test("falls back from Gemini to OpenAI when Google response has no image", async () => {
    const gemini = makeModel("hdwebsoft-proxy", "gemini-3.1-flash-image", {
      api: "google-generative-ai",
      baseUrl: "https://proxy-api.hdwebsoft.co/v1beta",
    });
    const openai = makeModel("openai", "gpt-image-2");
    const registry = makeRegistry(
      [gemini, openai],
      new Set(["hdwebsoft-proxy", "openai"])
    );
    let calls = 0;
    mockFetch((url, _init) => {
      calls++;
      if (url.includes("/interactions")) {
        return {
          status: 200,
          body: { steps: [{ type: "model_output", content: [] }] },
        };
      }
      return { status: 200, body: { data: [{ b64_json: "OPENAI" }] } };
    });

    const result = await runPainterFallback(
      registry,
      [gemini, openai],
      "generate",
      "a cat",
      [],
      "1024x1024",
      "medium",
      undefined
    );

    expect(result.json).toEqual({ data: [{ b64_json: "OPENAI" }] });
    expect(result.usedModel).toBe("openai/gpt-image-2");
    expect(result.errors).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test("falls back from Google HTTP error to OpenAI", async () => {
    const gemini = makeModel("hdwebsoft-proxy", "gemini-3.1-flash-image", {
      api: "google-generative-ai",
      baseUrl: "https://proxy-api.hdwebsoft.co/v1beta",
    });
    const openai = makeModel("openai", "gpt-image-2");
    const registry = makeRegistry(
      [gemini, openai],
      new Set(["hdwebsoft-proxy", "openai"])
    );
    let calls = 0;
    mockFetch((url, _init) => {
      calls++;
      if (url.includes("/interactions")) {
        return { status: 500, body: "gemini error" };
      }
      return { status: 200, body: { data: [{ b64_json: "OPENAI" }] } };
    });

    const result = await runPainterFallback(
      registry,
      [gemini, openai],
      "generate",
      "a cat",
      [],
      "1024x1024",
      "medium",
      undefined
    );

    expect(result.json).toEqual({ data: [{ b64_json: "OPENAI" }] });
    expect(result.usedModel).toBe("openai/gpt-image-2");
    expect(result.errors).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
