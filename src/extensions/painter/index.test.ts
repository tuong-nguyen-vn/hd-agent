import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  isPainterModel,
  runPainterFallback,
  type PainterFallbackOptions,
  type PainterRequest,
} from "./index";
import { ResponseChain } from "./chain";

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
  authedProviders: ReadonlySet<string>
): ModelRegistry {
  return {
    getAll: () => [...models],
    hasConfiguredAuth: (m: Model<Api>) => authedProviders.has(m.provider),
    getApiKeyAndHeaders: async (m: Model<Api>) => {
      if (!authedProviders.has(m.provider)) {
        return { ok: false, error: `No API key found for "${m.provider}"` };
      }
      return { ok: true, apiKey: `key-${m.provider}`, headers: undefined };
    },
  } as unknown as ModelRegistry;
}

function makeRequest(overrides: Partial<PainterRequest> = {}): PainterRequest {
  return { prompt: "a cat", inputs: [], ...overrides };
}

function makeOptions(
  overrides: Partial<PainterFallbackOptions> = {}
): PainterFallbackOptions {
  return {
    chain: new ResponseChain(),
    sessionId: "session-1",
    continueSession: true,
    ...overrides,
  };
}

const luna = () => makeModel("hdwebsoft-proxy", "gpt-6-luna");
const LUNA_KEY = "hdwebsoft-proxy/gpt-6-luna";

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
    } as Response;
  }) as typeof fetch;
}

function bodyOf(init: RequestInit | undefined): any {
  return typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
}

function responsesOk(id: string, result: string, outputFormat?: string) {
  return {
    status: 200,
    body: {
      id,
      output: [
        { type: "reasoning" },
        {
          type: "image_generation_call",
          result,
          ...(outputFormat ? { output_format: outputFormat } : {}),
        },
      ],
    },
  };
}

describe("isPainterModel", () => {
  test("keeps openai-completions chat models, rejects image-only endpoints", () => {
    expect(isPainterModel(luna())).toBe(true);
    expect(isPainterModel(makeModel("openai", "gpt-image-2"))).toBe(false);
    expect(
      isPainterModel(
        makeModel("hdwebsoft-proxy", "gemini-3.1-flash-image", {
          api: "google-generative-ai",
        })
      )
    ).toBe(false);
  });
});

describe("runPainterFallback", () => {
  test("posts the image_generation tool and omits unset options", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    let calledUrl = "";
    let postedBody: any;
    mockFetch((url, init) => {
      calledUrl = url;
      postedBody = bodyOf(init);
      return responsesOk("resp_1", "LUNA", "jpeg");
    });

    const result = await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions(),
      undefined
    );

    expect(calledUrl).toBe("https://hdwebsoft-proxy.example.com/v1/responses");
    expect(postedBody.model).toBe("gpt-6-luna");
    expect(postedBody.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "a cat" }] },
    ]);
    expect(postedBody.tools).toEqual([{ type: "image_generation" }]);
    expect(postedBody.tool_choice).toEqual({ type: "image_generation" });
    expect(postedBody.store).toBe(true);
    expect(postedBody.previous_response_id).toBeUndefined();
    expect(result.image).toEqual({
      b64: "LUNA",
      format: "jpeg",
      mimeType: "image/jpeg",
      responseId: "resp_1",
      chained: false,
    });
    expect(result.usedModel).toBe(LUNA_KEY);
    expect(result.errors).toEqual([]);
  });

  test("forwards the tool options the caller did set", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    let postedBody: any;
    mockFetch((_url, init) => {
      postedBody = bodyOf(init);
      return responsesOk("resp_1", "LUNA");
    });

    await runPainterFallback(
      registry,
      [model],
      makeRequest({
        action: "generate",
        quality: "high",
        size: "1536x1024",
        outputFormat: "jpeg",
        outputCompression: 80,
        background: "opaque",
      }),
      makeOptions(),
      undefined
    );

    expect(postedBody.tools).toEqual([
      {
        type: "image_generation",
        action: "generate",
        quality: "high",
        size: "1536x1024",
        output_format: "jpeg",
        output_compression: 80,
        background: "opaque",
      },
    ]);
  });

  test("drops output_compression for png output", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    let postedBody: any;
    mockFetch((_url, init) => {
      postedBody = bodyOf(init);
      return responsesOk("resp_1", "LUNA");
    });

    await runPainterFallback(
      registry,
      [model],
      makeRequest({ outputFormat: "png", outputCompression: 50 }),
      makeOptions(),
      undefined
    );

    expect(postedBody.tools[0].output_compression).toBeUndefined();
    expect(postedBody.tools[0].output_format).toBe("png");
  });

  test("defaults the format to png when the reply omits output_format", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    mockFetch(() => responsesOk("resp_1", "LUNA"));

    const result = await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions(),
      undefined
    );

    expect(result.image?.format).toBe("png");
    expect(result.image?.mimeType).toBe("image/png");
  });

  test("passes http(s) images by URL and inlines local files", async () => {
    const tmpPath = "/tmp/painter-responses-input.png";
    await Bun.write(tmpPath, Buffer.from("FAKEPNG", "base64"));
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    let postedBody: any;
    mockFetch((_url, init) => {
      postedBody = bodyOf(init);
      return responsesOk("resp_edit", "EDITED");
    });

    await runPainterFallback(
      registry,
      [model],
      makeRequest({
        prompt: "blue background",
        action: "edit",
        inputs: ["https://example.com/photo.jpg", tmpPath],
      }),
      makeOptions(),
      undefined
    );

    const content = postedBody.input[0].content;
    expect(content[0]).toEqual({ type: "input_text", text: "blue background" });
    expect(content[1]).toEqual({
      type: "input_image",
      image_url: "https://example.com/photo.jpg",
    });
    expect(content[2].type).toBe("input_image");
    expect(content[2].image_url).toStartWith("data:image/png;base64,");
    expect(postedBody.tools[0].action).toBe("edit");

    await Bun.file(tmpPath).delete();
  });

  test("chains the second call onto the first response id", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    const options = makeOptions();
    const sent: Array<string | undefined> = [];
    let n = 0;
    mockFetch((_url, init) => {
      sent.push(bodyOf(init).previous_response_id);
      n++;
      return responsesOk(`resp_${n}`, `IMG${n}`);
    });

    const first = await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      options,
      undefined
    );
    const second = await runPainterFallback(
      registry,
      [model],
      makeRequest({ prompt: "same cat, now waving" }),
      options,
      undefined
    );

    expect(sent).toEqual([undefined, "resp_1"]);
    expect(first.image?.chained).toBe(false);
    expect(second.image?.chained).toBe(true);
    expect(options.chain.get("session-1", LUNA_KEY)).toBe("resp_2");
  });

  test("continue_session=false skips the chain but still records it", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    const chain = new ResponseChain();
    chain.set("session-1", LUNA_KEY, "resp_old");
    const sent: Array<string | undefined> = [];
    mockFetch((_url, init) => {
      sent.push(bodyOf(init).previous_response_id);
      return responsesOk("resp_new", "FRESH");
    });

    await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions({ chain, continueSession: false }),
      undefined
    );

    expect(sent).toEqual([undefined]);
    expect(chain.get("session-1", LUNA_KEY)).toBe("resp_new");
  });

  test("retries unchained on a stale response id but keeps chaining", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    const chain = new ResponseChain();
    chain.set("session-1", LUNA_KEY, "resp_gone");
    const sent: Array<string | undefined> = [];
    mockFetch((_url, init) => {
      const previous = bodyOf(init).previous_response_id;
      sent.push(previous);
      if (previous) {
        return {
          status: 404,
          body: { error: { message: "Previous response not found" } },
        };
      }
      return responsesOk("resp_ok", "RETRY");
    });

    const first = await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions({ chain }),
      undefined
    );
    const second = await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions({ chain }),
      undefined
    );

    // The retry's response id is recorded, so the next call chains again.
    expect(sent).toEqual(["resp_gone", undefined, "resp_ok", undefined]);
    expect(first.image?.b64).toBe("RETRY");
    expect(first.errors).toEqual([]);
    expect(second.image?.b64).toBe("RETRY");
    expect(chain.supports(LUNA_KEY)).toBe(true);
  });

  test("stops chaining for a model whose API rejects previous_response_id", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    const chain = new ResponseChain();
    chain.set("session-1", LUNA_KEY, "resp_old");
    const sent: Array<string | undefined> = [];
    mockFetch((_url, init) => {
      const previous = bodyOf(init).previous_response_id;
      sent.push(previous);
      if (previous) {
        return {
          status: 400,
          body: {
            error: { message: "Unknown parameter: 'previous_response_id'" },
          },
        };
      }
      return responsesOk("resp_ok", "PLAIN");
    });

    await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions({ chain }),
      undefined
    );
    await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions({ chain }),
      undefined
    );

    expect(sent).toEqual(["resp_old", undefined, undefined]);
    expect(chain.supports(LUNA_KEY)).toBe(false);
  });

  test("does not repeat a chained request that failed for an unrelated reason", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    const chain = new ResponseChain();
    chain.set("session-1", LUNA_KEY, "resp_old");
    let calls = 0;
    mockFetch(() => {
      calls++;
      return { status: 502, body: "upstream timeout" };
    });

    const result = await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions({ chain }),
      undefined
    );

    expect(calls).toBe(1);
    expect(result.image).toBeUndefined();
    expect(result.errors[0]).toContain("502");
    expect(chain.supports(LUNA_KEY)).toBe(true);
  });

  test("falls back to the next candidate when the first errors", async () => {
    const bad = makeModel("proxy-a", "gpt-6-luna");
    const good = makeModel("proxy-b", "gpt-6-luna");
    const registry = makeRegistry([bad, good], new Set(["proxy-a", "proxy-b"]));
    let calls = 0;
    mockFetch((url) => {
      calls++;
      if (url.includes("proxy-a")) {
        return { status: 500, body: "boom" };
      }
      return responsesOk("resp_b", "BBBB");
    });

    const result = await runPainterFallback(
      registry,
      [bad, good],
      makeRequest(),
      makeOptions(),
      undefined
    );

    expect(result.image?.b64).toBe("BBBB");
    expect(result.usedModel).toBe("proxy-b/gpt-6-luna");
    expect(result.errors).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test("returns no image when all candidates fail", async () => {
    const a = makeModel("proxy-a", "gpt-6-luna");
    const b = makeModel("proxy-b", "gpt-6-luna");
    const registry = makeRegistry([a, b], new Set(["proxy-a", "proxy-b"]));
    mockFetch(() => ({ status: 500, body: "err" }));

    const result = await runPainterFallback(
      registry,
      [a, b],
      makeRequest(),
      makeOptions(),
      undefined
    );

    expect(result.image).toBeUndefined();
    expect(result.usedModel).toBeUndefined();
    expect(result.errors).toHaveLength(2);
  });

  test("skips unauthenticated candidates without calling fetch", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set([]));
    let called = false;
    mockFetch(() => {
      called = true;
      return { status: 200, body: {} };
    });

    const result = await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions(),
      undefined
    );

    expect(result.image).toBeUndefined();
    expect(called).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("auth for");
  });

  test("returns no image when there are no candidates", async () => {
    const registry = makeRegistry([], new Set());
    const result = await runPainterFallback(
      registry,
      [],
      makeRequest(),
      makeOptions(),
      undefined
    );
    expect(result.image).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  test("reports an error when the response carries no image", async () => {
    const model = luna();
    const registry = makeRegistry([model], new Set(["hdwebsoft-proxy"]));
    mockFetch(() => ({
      status: 200,
      body: { id: "resp_x", output: [{ type: "message" }] },
    }));

    const result = await runPainterFallback(
      registry,
      [model],
      makeRequest(),
      makeOptions(),
      undefined
    );

    expect(result.image).toBeUndefined();
    expect(result.errors[0]).toContain("image_generation_call");
  });
});

describe("ResponseChain", () => {
  test("keeps response ids separate per session and per model", () => {
    const chain = new ResponseChain();
    chain.set("a", "p/m", "resp_a");
    chain.set("b", "p/m", "resp_b");
    expect(chain.get("a", "p/m")).toBe("resp_a");
    expect(chain.get("a", "p/other")).toBeUndefined();
    chain.clear("a", "p/m");
    expect(chain.get("a", "p/m")).toBeUndefined();
    expect(chain.get("b", "p/m")).toBe("resp_b");
  });

  test("remembers the last image per session, independent of the model", () => {
    const chain = new ResponseChain();
    expect(chain.lastImage("a")).toBeUndefined();
    chain.setImage("a", "/tmp/one.jpg");
    chain.setImage("a", "/tmp/two.jpg");
    chain.setImage("b", "/tmp/other.jpg");
    expect(chain.lastImage("a")).toBe("/tmp/two.jpg");
    expect(chain.lastImage("b")).toBe("/tmp/other.jpg");
    chain.setImage("a", undefined);
    expect(chain.lastImage("a")).toBeUndefined();
  });

  test("evicts the oldest entries past the cap", () => {
    const chain = new ResponseChain();
    for (let i = 0; i < 70; i++) {
      chain.set(`s${i}`, "p/m", `resp_${i}`);
    }
    expect(chain.get("s0", "p/m")).toBeUndefined();
    expect(chain.get("s69", "p/m")).toBe("resp_69");
  });
});
