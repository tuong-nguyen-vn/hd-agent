import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ModelResolver, type ResolvedModel } from "../../shared/ModelResolver";
import { Paths } from "../../shared/Paths";
import { PimSettings } from "../../shared/PimSettings";
import {
  Renderer,
  type StatefulToolCallTitleContext,
} from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { ResponseChain } from "./chain";

const PREVIEW_LINES = 3;
const REQUEST_TIMEOUT_MS = 120_000;

const IMAGE_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const FORMAT_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};

const FORMAT_EXT: Readonly<Record<string, string>> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  webp: "webp",
};

/** The stored response is gone: drop the chain and retry, keep chaining later. */
const CHAIN_STALE = /previous[_ ]response|no such response|not found/i;
/** The API does not take `previous_response_id`/`store` at all: stop sending them. */
const CHAIN_UNSUPPORTED =
  /unknown parameter|unrecognized|unsupported|\bstore\b/i;

type PainterMode = "generate" | "edit";
type PainterSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";
type PainterQuality = "low" | "medium" | "high" | "xhigh" | "max" | "auto";
type PainterFormat = "png" | "jpeg" | "webp";
type PainterBackground = "transparent" | "opaque" | "auto";

type PainterInput = {
  readonly prompt: string;
  readonly mode?: PainterMode;
  readonly input?: readonly string[];
  readonly size?: PainterSize;
  readonly quality?: PainterQuality;
  readonly output_format?: PainterFormat;
  readonly output_compression?: number;
  readonly background?: PainterBackground;
  readonly continue_session?: boolean;
  readonly output_path?: string;
};

type PainterDetails = {
  readonly isError?: boolean;
  readonly path?: string;
  readonly mode?: string;
  readonly size?: string;
  readonly quality?: string;
  readonly bytes?: number;
  readonly model?: string;
  readonly chained?: boolean;
};

type PainterRenderContext = StatefulToolCallTitleContext & {
  readonly args?: Partial<PainterInput>;
  readonly cwd: string;
};

/**
 * A painter call. Every tool option is optional: anything the caller left out
 * is omitted from the request so the server picks its own default and the
 * cached prefix stays identical across calls.
 */
export type PainterRequest = {
  readonly prompt: string;
  readonly inputs: readonly string[];
  readonly action?: PainterMode;
  readonly size?: PainterSize;
  readonly quality?: PainterQuality;
  readonly outputFormat?: PainterFormat;
  readonly outputCompression?: number;
  readonly background?: PainterBackground;
};

export type PainterImage = {
  readonly b64: string;
  readonly format: string;
  readonly mimeType: string;
  readonly responseId?: string;
  readonly chained: boolean;
};

function isHttpUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

function mimeFromPath(p: string): string | undefined {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m?.[1] ? IMAGE_EXT[m[1]] : undefined;
}

function defaultOutputPath(format: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  return `painter-${ts}.${FORMAT_EXT[format] ?? "png"}`;
}

function errResult(text: string): AgentToolResult<PainterDetails> {
  return {
    content: [{ type: "text", text }],
    details: { isError: true },
  };
}

function authHeaders(
  apiKey: string | undefined,
  headers: Record<string, string | null> | undefined
): Record<string, string> {
  const hasAuth = Object.keys(headers ?? {}).some(
    (k) => k.toLowerCase() === "authorization"
  );
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (v !== null) {
      filtered[k] = v;
    }
  }
  return {
    ...(apiKey && !hasAuth ? { authorization: `Bearer ${apiKey}` } : {}),
    ...filtered,
  };
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function requestError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  return error instanceof Error ? error.message : String(error);
}

function renderTitle(
  args: Partial<PainterInput> | undefined,
  theme: Theme,
  context: PainterRenderContext
) {
  const hasInput = Array.isArray(args?.input) && (args!.input!.length ?? 0) > 0;
  const mode = args?.mode ?? (hasInput ? "edit" : "generate");
  const promptPreview = String(args?.prompt ?? "").slice(0, 60);
  const title = promptPreview || "...";
  const markerColor = Renderer.markerColorFor(
    Boolean(context.isPartial),
    Boolean(context.isError)
  );
  return Renderer.renderStatefulToolCallTitle({
    label: `Painter (${mode})`,
    title,
    theme,
    context,
    markerGlyph: Renderer.markerGlyphFor(markerColor),
    separator: " ",
    useSpinner: true,
  });
}

function fileToBase64(path: string): Promise<string> {
  return Bun.file(path)
    .arrayBuffer()
    .then((buf) => Buffer.from(buf).toString("base64"));
}

/**
 * painter speaks one protocol: `/responses` with the `image_generation` tool.
 * That rules out image-only endpoints (`gpt-image-*`, Gemini image models).
 */
export function isPainterModel(model: Model<Api>): boolean {
  return model.api === "openai-completions" && !/^gpt-image/i.test(model.id);
}

function imageGenerationTool(request: PainterRequest) {
  const format = request.outputFormat;
  return {
    type: "image_generation",
    ...(request.action ? { action: request.action } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.size ? { size: request.size } : {}),
    ...(format ? { output_format: format } : {}),
    ...(request.outputCompression !== undefined &&
    (format === "jpeg" || format === "webp")
      ? { output_compression: request.outputCompression }
      : {}),
    ...(request.background ? { background: request.background } : {}),
  };
}

type ResponsesContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

/**
 * Text first, then images — the order in the API docs, and the one that keeps
 * a reused prompt at the head of the cached prefix. Remote images are passed
 * by URL rather than inlined, so the bytes stay out of the request.
 */
async function responsesContent(
  prompt: string,
  inputs: readonly string[]
): Promise<ResponsesContent[]> {
  const content: ResponsesContent[] = [{ type: "input_text", text: prompt }];
  for (const ref of inputs) {
    if (isHttpUrl(ref)) {
      content.push({ type: "input_image", image_url: ref });
      continue;
    }
    const mime = mimeFromPath(ref) ?? "image/png";
    const data = await fileToBase64(ref);
    content.push({
      type: "input_image",
      image_url: `data:${mime};base64,${data}`,
    });
  }
  return content;
}

type ResponsesOutputItem = {
  type?: string;
  result?: string;
  output_format?: string;
};

async function callResponses(
  resolved: ResolvedModel,
  request: PainterRequest,
  previousResponseId: string | undefined,
  signal: AbortSignal | undefined
): Promise<PainterImage> {
  const { model, apiKey, headers } = resolved;
  const body = {
    model: model.id,
    input: [
      {
        role: "user",
        content: await responsesContent(request.prompt, request.inputs),
      },
    ],
    tools: [imageGenerationTool(request)],
    tool_choice: { type: "image_generation" },
    store: true,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
  };
  const r = await fetch(`${model.baseUrl}/responses`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...authHeaders(apiKey, headers),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`responses ${r.status}: ${detail.slice(0, 400)}`);
  }
  const json = (await r.json()) as {
    id?: string;
    output?: ResponsesOutputItem[];
  };
  const call = json.output?.find(
    (item) => item.type === "image_generation_call" && Boolean(item.result)
  );
  if (!call?.result) {
    throw new Error("responses reply had no image_generation_call result");
  }
  const format = call.output_format ?? request.outputFormat ?? "png";
  return {
    b64: call.result,
    format,
    mimeType: FORMAT_MIME[format] ?? "image/png",
    responseId: json.id,
    chained: previousResponseId !== undefined,
  };
}

/**
 * Chains the call onto this session's previous painter response so the model
 * reuses its cached text context. Retries once unchained only when the
 * provider rejected the chain itself — any other failure surfaces as-is, so
 * a request that may already have painted is never silently repeated.
 */
async function callResponsesChained(
  resolved: ResolvedModel,
  request: PainterRequest,
  modelKey: string,
  options: PainterFallbackOptions,
  signal: AbortSignal | undefined
): Promise<PainterImage> {
  const { chain, sessionId, continueSession } = options;
  const previous =
    continueSession && chain.supports(modelKey)
      ? chain.get(sessionId, modelKey)
      : undefined;
  try {
    const image = await callResponses(resolved, request, previous, signal);
    chain.set(sessionId, modelKey, image.responseId);
    return image;
  } catch (err) {
    const reason = requestError(err);
    const unsupported = CHAIN_UNSUPPORTED.test(reason);
    if (
      previous === undefined ||
      signal?.aborted ||
      !(unsupported || CHAIN_STALE.test(reason))
    ) {
      throw err;
    }
    chain.clear(sessionId, modelKey);
    if (unsupported) {
      chain.markUnsupported(modelKey);
    }
    const image = await callResponses(resolved, request, undefined, signal);
    chain.set(sessionId, modelKey, image.responseId);
    return image;
  }
}

export type PainterFallbackOptions = {
  readonly chain: ResponseChain;
  readonly sessionId: string;
  readonly continueSession: boolean;
};

export type PainterFallbackResult = {
  readonly image: PainterImage | undefined;
  readonly usedModel: string | undefined;
  readonly errors: readonly string[];
};

/**
 * Tries each model candidate in order, returning the first image produced.
 * Exported for tests.
 */
export async function runPainterFallback(
  registry: ModelRegistry,
  candidates: readonly Model<Api>[],
  request: PainterRequest,
  options: PainterFallbackOptions,
  signal: AbortSignal | undefined
): Promise<PainterFallbackResult> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    const modelKey = `${candidate.provider}/${candidate.id}`;
    let resolved: ResolvedModel;
    try {
      resolved = await ModelResolver.resolveAuth(registry, candidate);
    } catch (err) {
      errors.push(
        `auth for "${modelKey}": ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    try {
      const image = await callResponsesChained(
        resolved,
        request,
        modelKey,
        options,
        signal
      );
      return { image, usedModel: modelKey, errors };
    } catch (err) {
      errors.push(`painter model "${modelKey}": ${requestError(err)}`);
      if (signal?.aborted) {
        break;
      }
    }
  }
  return { image: undefined, usedModel: undefined, errors };
}

export default function (pi: ExtensionAPI): void {
  const chain = new ResponseChain();

  Tools.register(pi, {
    name: "painter",
    label: "painter",
    description:
      "Generate or edit images. Use mode='generate' for text→image (mockups, icons, hero images, diagrams) " +
      "and mode='edit' with 1-3 input images or URLs for edits, compositing, or redaction " +
      "(e.g. blur API keys/passwords in screenshots). Saves the image and renders it inline. " +
      "Calls in a session chain onto the previous painter response (text context + prompt cache). " +
      "For a follow-up that must stay visually consistent ('same character, now waving'), use " +
      "mode='edit' without `input`: painter re-attaches the last image it made. Leave size/quality " +
      "unset unless the user asked for a specific one — the server picks, and a stable request keeps " +
      "the context cache warm.",
    promptSnippet: "Generate or edit an image",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Image generation/edit prompt. Be specific: subject, style, colors, composition, text to render.",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("generate"), Type.Literal("edit")], {
          description:
            "generate = text→image; edit = input images + prompt → new image. " +
            "Omit to let the server decide from the inputs.",
        })
      ),
      input: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "1-3 input images for edit mode (redaction, style edit, reference-guided generation). " +
            "Local paths are inlined; http(s) URLs are passed through as-is. " +
            "Omit in edit mode to edit the last image painter made in this session.",
        })
      ),
      size: Type.Optional(
        Type.Union(
          [
            Type.Literal("1024x1024"),
            Type.Literal("1024x1536"),
            Type.Literal("1536x1024"),
            Type.Literal("auto"),
          ],
          {
            description:
              "Output size. Omit to let the model choose the aspect ratio that fits the prompt.",
          }
        )
      ),
      quality: Type.Optional(
        Type.Union(
          [
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("xhigh"),
            Type.Literal("max"),
            Type.Literal("auto"),
          ],
          { description: "Output quality. Omit for the server default." }
        )
      ),
      output_format: Type.Optional(
        Type.Union(
          [Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")],
          { description: "Output file format. Omit for png." }
        )
      ),
      output_compression: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 100,
          description:
            "0-100 compression, only sent when output_format is jpeg or webp.",
        })
      ),
      background: Type.Optional(
        Type.Union(
          [
            Type.Literal("transparent"),
            Type.Literal("opaque"),
            Type.Literal("auto"),
          ],
          {
            description:
              "Background handling. Use 'transparent' with png/webp for icons and logos.",
          }
        )
      ),
      continue_session: Type.Optional(
        Type.Boolean({
          description:
            "Default true: chain onto this session's previous painter response (text context, " +
            "prompt-cache hits, last image for edits). Set false to start a fresh, unrelated image.",
        })
      ),
      output_path: Type.Optional(
        Type.String({
          description:
            "Output image path. Default ./painter-<timestamp>.<format>",
        })
      ),
    }),
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = params as PainterInput;

      const modelRef = await PimSettings.getPainterModel();
      const candidates = (
        await ModelResolver.resolveCandidates(
          ctx.modelRegistry,
          modelRef,
          ctx.model?.provider
        )
      ).filter(isPainterModel);
      if (candidates.length === 0) {
        return errResult(
          `painter: no model "${modelRef}" found in any configured provider. ` +
            `painter needs an "openai-completions" model whose provider serves /responses with the ` +
            `image_generation tool (e.g. gpt-6-luna); set painter.model in ~/.pim/settings.json.`
        );
      }

      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) {
        return errResult("painter: `prompt` is required");
      }

      // Local paths are resolved against the session cwd (not the process
      // cwd) so subagents and resumed sessions read the files they mean.
      const inputs: string[] = Array.isArray(args.input)
        ? args.input
            .filter((p) => typeof p === "string" && p.length > 0)
            .map((p) => (isHttpUrl(p) ? p : Paths.resolve(p, ctx.cwd)))
        : [];
      const mode = args.mode;
      const sessionId = ctx.sessionManager.getSessionId();
      const continueSession = args.continue_session !== false;

      // An edit with no `input` means "edit the image painter made last". The
      // image tool only sees images in the current request (the response
      // chain does not count as previous context), so that file is re-sent.
      if (mode === "edit" && inputs.length === 0) {
        const last = continueSession ? chain.lastImage(sessionId) : undefined;
        if (!last || !(await Bun.file(last).exists())) {
          return errResult(
            "painter: edit mode requires at least one `input` image (no earlier painter image is available in this session)"
          );
        }
        inputs.push(last);
      }
      for (const p of inputs) {
        if (!isHttpUrl(p) && !(await Bun.file(p).exists())) {
          return errResult(`painter: input image not readable: "${p}"`);
        }
      }

      const request: PainterRequest = {
        prompt,
        inputs,
        ...(mode ? { action: mode } : {}),
        ...(args.size ? { size: args.size } : {}),
        ...(args.quality ? { quality: args.quality } : {}),
        ...(args.output_format ? { outputFormat: args.output_format } : {}),
        ...(args.output_compression !== undefined
          ? { outputCompression: args.output_compression }
          : {}),
        ...(args.background ? { background: args.background } : {}),
      };

      if (signal?.aborted) {
        throw new Error("painter aborted before execution.");
      }
      const activeSignal = requestSignal(signal);

      const outcome = await runPainterFallback(
        ctx.modelRegistry,
        candidates,
        request,
        { chain, sessionId, continueSession },
        activeSignal
      );
      if (!outcome.image) {
        return errResult(
          `painter: all model candidates failed. ${outcome.errors.join(" | ")}`
        );
      }
      const image = outcome.image;
      const bytes = Buffer.from(image.b64, "base64");

      const outPath = Paths.resolve(
        String(args.output_path ?? "").trim() ||
          defaultOutputPath(image.format),
        ctx.cwd
      );

      try {
        await Bun.write(outPath, bytes);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errResult(
          `painter: generated image but failed to write "${outPath}": ${msg}`
        );
      }
      chain.setImage(sessionId, outPath);

      const size = args.size ?? "auto";
      const quality = args.quality ?? "auto";
      return {
        content: [
          {
            type: "text" as const,
            text:
              `painter ${mode ?? (inputs.length > 0 ? "edit" : "generate")} → ${outPath}` +
              `  (${size}, ${quality}, ${(bytes.length / 1024).toFixed(0)} KB)` +
              (image.chained
                ? "  [chained to the previous painter response]"
                : ""),
          },
          { type: "image" as const, data: image.b64, mimeType: image.mimeType },
        ],
        details: {
          path: outPath,
          mode: mode ?? "auto",
          size,
          quality,
          bytes: bytes.length,
          model: outcome.usedModel,
          chained: image.chained,
        } satisfies PainterDetails,
      };
    },
    renderCall(args, theme, context) {
      return renderTitle(
        (args ?? {}) as Partial<PainterInput>,
        theme,
        context as PainterRenderContext
      );
    },
    renderResult(result, options, theme, context) {
      const ctx = context as PainterRenderContext;
      renderTitle(ctx.args ?? {}, theme, ctx);

      const details = result.details as PainterDetails | undefined;
      if (details?.isError) {
        return Renderer.renderBorderedResult({
          result,
          options,
          theme,
          context: ctx,
          previewLines: PREVIEW_LINES,
        });
      }

      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context: ctx,
        previewLines: PREVIEW_LINES,
        showCollapsedSuccess: true,
      });
    },
  });
}
