import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type CapturedImage,
  IMAGE_GENERATION_TOOL,
  NativeImageCapture,
} from "./NativeImageCapture";

// A 1x1 PNG; small enough to keep the SSE fixtures readable.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type Captured = Omit<CapturedImage, "model">;

function imagesChunk(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "resp_1",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          images: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${PNG_B64}` },
            },
          ],
          ...extra,
        },
        finish_reason: null,
      },
    ],
  });
}

const STRIPPED_CHUNK = JSON.stringify({
  id: "resp_1",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
});

const FINISH_CHUNK = JSON.stringify({
  id: "resp_1",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
});

function collect(): { images: Captured[]; onImage: (i: Captured) => void } {
  const images: Captured[] = [];
  return { images, onImage: (image) => images.push(image) };
}

describe("NativeImageCapture.rewriteSseEvent", () => {
  test("returns events without images untouched, same reference", () => {
    const { images, onImage } = collect();
    for (const lines of [
      [": keep-alive"],
      ["event: ping"],
      [`data: ${FINISH_CHUNK}`],
      ["data: [DONE]"],
      ['data: {"choices":[{"delta":{"content":"hi"}}]}'],
      ["id: 7", `data: ${FINISH_CHUNK}`],
    ]) {
      expect(NativeImageCapture.rewriteSseEvent(lines, onImage)).toBe(lines);
    }
    expect(images).toEqual([]);
  });

  test("captures delta.images and strips them from the chunk", () => {
    const { images, onImage } = collect();
    const out = NativeImageCapture.rewriteSseEvent(
      [`data: ${imagesChunk()}`],
      onImage
    );

    expect(images).toEqual([{ mimeType: "image/png", data: PNG_B64 }]);
    expect(out).toEqual([`data: ${STRIPPED_CHUNK}`]);
  });

  test("joins multi-line data fields before parsing and keeps other fields", () => {
    const { images, onImage } = collect();
    const json = imagesChunk({ content: "here you go" });
    const cut = json.indexOf('"images"');
    const out = NativeImageCapture.rewriteSseEvent(
      [
        "event: delta",
        `data: ${json.slice(0, cut)}`,
        `data:${json.slice(cut)}`,
      ],
      onImage
    );

    expect(images).toHaveLength(1);
    expect(out[0]).toBe("event: delta");
    expect(out).toHaveLength(2);
    const chunk = JSON.parse(out[1]!.slice("data: ".length));
    expect(chunk.choices[0].delta).toEqual({
      role: "assistant",
      content: "here you go",
    });
  });

  test("captures message.images from a non-streamed body", () => {
    const { images, onImage } = collect();
    const line = `data: ${JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            images: [
              { image_url: { url: `data:image/jpeg;base64,${PNG_B64}` } },
            ],
          },
        },
      ],
    })}`;
    const out = NativeImageCapture.rewriteSseEvent([line], onImage);
    expect(images).toEqual([{ mimeType: "image/jpeg", data: PNG_B64 }]);
    expect(out[0]).not.toContain("images");
  });

  test("ignores malformed JSON and non-data-URI images", () => {
    const { images, onImage } = collect();
    const broken = ['data: {"choices":[{"delta":{"images":['];
    expect(NativeImageCapture.rewriteSseEvent(broken, onImage)).toBe(broken);

    const remote = [
      `data: ${JSON.stringify({
        choices: [
          { delta: { images: [{ image_url: { url: "https://x/y.png" } }] } },
        ],
      })}`,
    ];
    const out = NativeImageCapture.rewriteSseEvent(remote, onImage);
    expect(images).toEqual([]);
    expect(out[0]).not.toContain("images");
  });
});

describe("NativeImageCapture.teeFetch", () => {
  function sseResponse(body: string, chunkSize: number): Response {
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "content-length": String(bytes.length),
        "content-encoding": "gzip",
      },
    });
  }

  async function run(body: string, chunkSize: number) {
    const { images, onImage } = collect();
    const fetch = NativeImageCapture.teeFetch(
      async () => sseResponse(body, chunkSize),
      onImage
    );
    const response = await fetch("https://proxy.example/v1/chat/completions");
    return { images, response, text: await response.text() };
  }

  test("rewrites an event stream split across arbitrary chunk boundaries", async () => {
    const body = `data: ${imagesChunk()}\n\ndata: ${FINISH_CHUNK}\n\ndata: [DONE]\n\n`;
    const { images, response, text } = await run(body, 7);

    expect(images).toHaveLength(1);
    expect(text).toBe(
      `data: ${STRIPPED_CHUNK}\n\ndata: ${FINISH_CHUNK}\n\ndata: [DONE]\n\n`
    );
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });

  test("keeps CRLF framing and passes untouched events through byte for byte", async () => {
    const body = `: hello\r\n\r\nid: 1\r\ndata: ${imagesChunk()}\r\n\r\ndata: ${FINISH_CHUNK}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const { images, text } = await run(body, 5);

    expect(images).toHaveLength(1);
    expect(text).toBe(
      `: hello\r\n\r\nid: 1\r\ndata: ${STRIPPED_CHUNK}\r\n\r\ndata: ${FINISH_CHUNK}\r\n\r\ndata: [DONE]\r\n\r\n`
    );
  });

  test("handles multi-line data events and a stream without a final blank line", async () => {
    const json = imagesChunk();
    const cut = json.indexOf('"images"');
    const body = `data: ${json.slice(0, cut)}\ndata: ${json.slice(cut)}\n\ndata: [DONE]`;
    const { images, text } = await run(body, 3);

    expect(images).toHaveLength(1);
    expect(text).toBe(`data: ${STRIPPED_CHUNK}\n\ndata: [DONE]`);
  });

  test("passes non-stream and error responses through untouched", async () => {
    const { images, onImage } = collect();
    const json = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const failed = new Response("nope", {
      status: 500,
      headers: { "content-type": "text/event-stream" },
    });
    let next = json;
    const fetch = NativeImageCapture.teeFetch(async () => next, onImage);

    expect(await fetch("https://x")).toBe(json);
    next = failed;
    expect(await fetch("https://x")).toBe(failed);
    expect(images).toEqual([]);
  });
});

describe("NativeImageCapture.injectImageTool", () => {
  const payload = {
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "draw a cat" }],
    tools: [{ type: "function", function: { name: "bash" } }],
    stream: true,
  };

  test("appends the image tool after the function tools", () => {
    const out = NativeImageCapture.injectImageTool(payload, "gpt-5.6-luna");
    expect(out).toEqual({
      ...payload,
      tools: [...payload.tools, IMAGE_GENERATION_TOOL],
    });
    expect(payload.tools).toHaveLength(1);
  });

  test("creates the tools array when the request had none", () => {
    const { tools: _tools, ...bare } = payload;
    const out = NativeImageCapture.injectImageTool(bare, "gpt-5.6-luna");
    expect(out?.tools).toEqual([IMAGE_GENERATION_TOOL]);
  });

  test("leaves other models, non-chat payloads and duplicates alone", () => {
    expect(
      NativeImageCapture.injectImageTool(payload, "gemini-3.8-flash")
    ).toBeUndefined();
    expect(
      NativeImageCapture.injectImageTool(
        { model: "gpt-5.6-luna", input: [] },
        "gpt-5.6-luna"
      )
    ).toBeUndefined();
    expect(
      NativeImageCapture.injectImageTool(
        { ...payload, tools: [IMAGE_GENERATION_TOOL] },
        "gpt-5.6-luna"
      )
    ).toBeUndefined();
    expect(NativeImageCapture.injectImageTool(null, "x")).toBeUndefined();
  });
});

describe("NativeImageCapture.streamSimple", () => {
  const model = {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    api: "openai-completions",
    provider: "hdwebsoft-proxy",
    baseUrl: "https://proxy.example/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } as Model<Api>;

  function stubFetch(body: string, seen: string[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      seen.push(input.toString());
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
  }

  async function finish(stream: AsyncIterable<any>) {
    let final: { content: unknown[]; stopReason: string } | undefined;
    for await (const event of stream) {
      if (event.type === "done") {
        final = event.message;
      }
      if (event.type === "error") {
        throw new Error(event.error.errorMessage);
      }
    }
    return final;
  }

  test("runs pi-ai's completions driver and keeps the image the driver drops, per session", async () => {
    NativeImageCapture.drain("s1");
    NativeImageCapture.drain("s2");
    const body = `data: ${imagesChunk()}\n\ndata: ${FINISH_CHUNK}\n\ndata: [DONE]\n\n`;
    const seen: string[] = [];
    const streamSimple = NativeImageCapture.streamSimpleFor("hdwebsoft-proxy");
    const context = {
      messages: [{ role: "user", content: "draw", timestamp: 0 }],
    } as any;

    const final = await finish(
      streamSimple(model, context, {
        apiKey: "stub",
        sessionId: "s1",
        fetch: stubFetch(body, seen),
      })
    );

    expect(seen).toEqual(["https://proxy.example/v1/chat/completions"]);
    expect(final?.stopReason).toBe("stop");
    expect(final?.content).toEqual([]);
    expect(NativeImageCapture.hasTee("hdwebsoft-proxy")).toBe(true);
    expect(NativeImageCapture.peek("s2")).toEqual([]);
    expect(NativeImageCapture.drain("s1")).toEqual([
      { mimeType: "image/png", data: PNG_B64, model: "gpt-5.6-luna" },
    ]);
    expect(NativeImageCapture.peek("s1")).toEqual([]);
  });
});
