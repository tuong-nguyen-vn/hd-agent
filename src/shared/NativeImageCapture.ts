import type {
  Api,
  AssistantMessageEventStream,
  TranscriptContext,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

export type CapturedImage = {
  readonly data: string;
  readonly mimeType: string;
  readonly model: string;
};

/** The server-side tool appended to a native model's chat request. */
export const IMAGE_GENERATION_TOOL = {
  type: "image_generation",
  output_format: "jpeg",
} as const;

/** Streams that carry no pi session id (SDK callers) share one bucket. */
const NO_SESSION = "";

type ImagesChunk = {
  choices?: Array<{
    delta?: { images?: unknown };
    message?: { images?: unknown };
  }>;
};

type ImageEntry = { image_url?: { url?: unknown } };

/** What pi-ai actually calls; Bun's `typeof fetch` also demands `preconnect`. */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

type SseLine = { readonly text: string; readonly terminator: string };

type SharedState = {
  readonly captured: Map<string, CapturedImage[]>;
  readonly providers: Set<string>;
};

// pi loads every extension through jiti with `moduleCache: false`, so this
// module is evaluated once per extension. The provider extension fills the
// buffer and the native-image extension drains it, so the state has to live
// on the process, not on the class.
const STATE_KEY = Symbol.for("hd-agent.native-image-capture");
const shared: SharedState = ((globalThis as Record<symbol, unknown>)[
  STATE_KEY
] ??= { captured: new Map(), providers: new Set<string>() }) as SharedState;

/**
 * Lets the main agent paint through the proxy's `image_generation` tool on
 * `/chat/completions`. pi-ai's completions driver never looks at the
 * `images` field the proxy returns, so the bytes would be dropped on the
 * floor; this reads them out of the SSE stream on the way past, then hands
 * the stream to the stock driver untouched otherwise. Captures are keyed by
 * the pi session that made the request, so a subagent streaming through the
 * same provider never leaks into the main conversation. The native-image
 * extension drains its session's captures at `turn_end` and posts them back
 * as an image-bearing custom message.
 */
export class NativeImageCapture {
  /**
   * Builds a provider's `streamSimple` for its `openai-completions` models
   * and remembers that the provider is teed, which is what makes injecting
   * the tool into its requests safe.
   */
  public static streamSimpleFor(
    providerId: string
  ): (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions
  ) => AssistantMessageEventStream {
    shared.providers.add(providerId);
    return NativeImageCapture.streamSimple;
  }

  public static hasTee(providerId: string): boolean {
    return shared.providers.has(providerId);
  }

  /** Provider `streamSimple` for `openai-completions` models. */
  public static streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const base: FetchLike = options?.fetch ?? globalThis.fetch;
    const session = options?.sessionId ?? NO_SESSION;
    const fetch = NativeImageCapture.teeFetch(base, (image) => {
      const bucket = shared.captured.get(session) ?? [];
      bucket.push({ ...image, model: model.id });
      shared.captured.set(session, bucket);
    });
    return openAICompletionsApi().streamSimple(model, context, {
      ...options,
      fetch: fetch as typeof globalThis.fetch,
    });
  }

  /** Images captured for a session since its last drain, in arrival order. */
  public static peek(sessionId: string): readonly CapturedImage[] {
    return shared.captured.get(sessionId) ?? [];
  }

  public static drain(sessionId: string): readonly CapturedImage[] {
    const images = shared.captured.get(sessionId) ?? [];
    shared.captured.delete(sessionId);
    return images;
  }

  /**
   * Appends the image tool to a completions payload bound for `modelId`.
   * Returns undefined when the payload is not that model's chat request or
   * already carries the tool, so the caller can leave it alone.
   */
  public static injectImageTool(
    payload: unknown,
    modelId: string
  ): Record<string, unknown> | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const body = payload as {
      model?: unknown;
      messages?: unknown;
      tools?: unknown;
    };
    if (body.model !== modelId || !Array.isArray(body.messages)) {
      return undefined;
    }
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const present = tools.some(
      (tool) =>
        Boolean(tool) &&
        typeof tool === "object" &&
        (tool as { type?: unknown }).type === IMAGE_GENERATION_TOOL.type
    );
    if (present) {
      return undefined;
    }
    return { ...body, tools: [...tools, IMAGE_GENERATION_TOOL] };
  }

  /**
   * Wraps `fetch` so event-stream bodies pass through `rewriteSseEvent`, one
   * SSE event (blank-line delimited; LF, CRLF or CR framing) at a time.
   * Non-stream responses are returned as-is.
   */
  public static teeFetch(
    base: FetchLike,
    onImage: (image: Omit<CapturedImage, "model">) => void
  ): FetchLike {
    return async (input, init) => {
      const response = await base(input, init);
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !response.ok ||
        !response.body ||
        !contentType.includes("text/event-stream")
      ) {
        return response;
      }
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let pending = "";
      let event: SseLine[] = [];

      const emitEvent = (
        controller: TransformStreamDefaultController<Uint8Array>,
        blank: SseLine | undefined
      ): void => {
        const lines = NativeImageCapture.rewriteSseEvent(
          event.map((line) => line.text),
          onImage
        );
        const terminators = event.map((line) => line.terminator);
        event = [];
        let out = "";
        for (let i = 0; i < lines.length; i++) {
          out += lines[i] + (terminators[i] ?? terminators.at(-1) ?? "\n");
        }
        if (blank) {
          out += blank.text + blank.terminator;
        }
        if (out.length > 0) {
          controller.enqueue(encoder.encode(out));
        }
      };

      const consume = (
        controller: TransformStreamDefaultController<Uint8Array>,
        flushing: boolean
      ): void => {
        for (;;) {
          const lf = pending.indexOf("\n");
          const cr = pending.indexOf("\r");
          const at = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
          if (at < 0) {
            break;
          }
          // A trailing CR may be the first half of CRLF still in flight.
          if (pending[at] === "\r" && at === pending.length - 1 && !flushing) {
            break;
          }
          const terminatorLength =
            pending[at] === "\r" && pending[at + 1] === "\n" ? 2 : 1;
          const line: SseLine = {
            text: pending.slice(0, at),
            terminator: pending.slice(at, at + terminatorLength),
          };
          pending = pending.slice(at + terminatorLength);
          if (line.text.length === 0) {
            emitEvent(controller, line);
          } else {
            event.push(line);
          }
        }
      };

      const rewrite = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          consume(controller, false);
        },
        flush(controller) {
          pending += decoder.decode();
          consume(controller, true);
          if (pending.length > 0) {
            event.push({ text: pending, terminator: "" });
            pending = "";
          }
          if (event.length > 0) {
            emitEvent(controller, undefined);
          }
        },
      });
      // The body is already decoded, so the original length/encoding headers
      // would describe bytes the reader never sees.
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(response.body.pipeThrough(rewrite), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
  }

  /**
   * Pulls `choices[].delta.images` (or `message.images`) out of one SSE
   * event's lines (terminators stripped), reporting each data-URI image and
   * returning the event without them. Per the SSE spec the payload is every
   * `data:` field joined with newlines; when images are found those lines
   * collapse into one. Events that carry no images come back as the same
   * array.
   */
  public static rewriteSseEvent(
    lines: readonly string[],
    onImage: (image: Omit<CapturedImage, "model">) => void
  ): readonly string[] {
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (
      dataLines.length === 0 ||
      !dataLines.some((line) => line.includes('"images"'))
    ) {
      return lines;
    }
    const payload = dataLines
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    let chunk: ImagesChunk;
    try {
      chunk = JSON.parse(payload) as ImagesChunk;
    } catch {
      return lines;
    }
    let changed = false;
    for (const choice of chunk.choices ?? []) {
      for (const holder of [choice.delta, choice.message]) {
        if (!holder || !Array.isArray(holder.images)) {
          continue;
        }
        for (const entry of holder.images as ImageEntry[]) {
          const image = NativeImageCapture.parseDataUri(entry?.image_url?.url);
          if (image) {
            onImage(image);
          }
        }
        delete holder.images;
        changed = true;
      }
    }
    if (!changed) {
      return lines;
    }
    return [
      ...lines.filter((line) => !line.startsWith("data:")),
      `data: ${JSON.stringify(chunk)}`,
    ];
  }

  private static parseDataUri(
    url: unknown
  ): Omit<CapturedImage, "model"> | undefined {
    if (typeof url !== "string") {
      return undefined;
    }
    const match = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      return undefined;
    }
    return { mimeType: match[1]!, data: match[2]! };
  }
}
