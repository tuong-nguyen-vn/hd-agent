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

type PainterInput = {
  readonly prompt: string;
  readonly mode?: "generate" | "edit";
  readonly input?: readonly string[];
  readonly size?: "1024x1024" | "1792x1024" | "1024x1792";
  readonly quality?: "low" | "medium" | "high";
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
};

type PainterRenderContext = StatefulToolCallTitleContext & {
  readonly args?: Partial<PainterInput>;
  readonly cwd: string;
};

function mimeFromPath(p: string): string | undefined {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m?.[1] ? IMAGE_EXT[m[1]] : undefined;
}

function defaultOutputPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `painter-${ts}.png`;
}

function errResult(text: string): AgentToolResult<PainterDetails> {
  return {
    content: [{ type: "text", text }],
    details: { isError: true },
  };
}

function authHeaders(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined
): Record<string, string> {
  const hasAuth = Object.keys(headers ?? {}).some(
    (k) => k.toLowerCase() === "authorization"
  );
  return {
    ...(apiKey && !hasAuth ? { authorization: `Bearer ${apiKey}` } : {}),
    ...headers,
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

function googleAuthHeaders(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined
): Record<string, string> {
  const hasGoogle = Object.keys(headers ?? {}).some(
    (k) => k.toLowerCase() === "x-goog-api-key"
  );
  const base = authHeaders(apiKey, headers);
  if (apiKey && !hasGoogle) {
    base["x-goog-api-key"] = apiKey;
  }
  return base;
}

async function callGenerate(
  resolved: ResolvedModel,
  prompt: string,
  size: string,
  quality: string,
  signal: AbortSignal | undefined
) {
  const { model, apiKey, headers } = resolved;
  const r = await fetch(`${model.baseUrl}/images/generations`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...authHeaders(apiKey, headers),
    },
    body: JSON.stringify({ model: model.id, prompt, n: 1, size, quality }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`generate ${r.status}: ${detail.slice(0, 400)}`);
  }
  return await r.json();
}

async function callEdit(
  resolved: ResolvedModel,
  prompt: string,
  inputs: readonly string[],
  size: string,
  quality: string,
  signal: AbortSignal | undefined
) {
  const { model, apiKey, headers } = resolved;
  const form = new FormData();
  form.append("model", model.id);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", quality);
  for (const p of inputs) {
    const buf = await Bun.file(p).arrayBuffer();
    const mime = mimeFromPath(p) ?? "image/png";
    const fieldName = inputs.length > 1 ? "image[]" : "image";
    const basename = Paths.toForwardSlashes(p).split("/").pop() ?? p;
    form.append(fieldName, new Blob([buf], { type: mime }), basename);
  }
  const r = await fetch(`${model.baseUrl}/images/edits`, {
    method: "POST",
    signal,
    headers: authHeaders(apiKey, headers),
    body: form,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`edit ${r.status}: ${detail.slice(0, 400)}`);
  }
  return await r.json();
}

async function interactionInput(
  prompt: string,
  inputs: readonly string[]
): Promise<
  Array<
    | { type: "text"; text: string }
    | { type: "image"; mime_type: string; data: string }
  >
> {
  const result: Array<
    | { type: "text"; text: string }
    | { type: "image"; mime_type: string; data: string }
  > = [{ type: "text", text: prompt }];
  for (const p of inputs) {
    const mime = mimeFromPath(p) ?? "image/png";
    const data = await fileToBase64(p);
    result.push({ type: "image", mime_type: mime, data });
  }
  return result;
}

type GoogleInteractionStep = {
  type?: string;
  content?: Array<{
    type?: string;
    mime_type?: string;
    data?: string;
  }>;
};

async function callGoogleInteraction(
  resolved: ResolvedModel,
  prompt: string,
  inputs: readonly string[],
  signal: AbortSignal | undefined
) {
  const { model, apiKey, headers } = resolved;
  const body = {
    model: model.id,
    input: await interactionInput(prompt, inputs),
  };
  const r = await fetch(`${model.baseUrl}/interactions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...googleAuthHeaders(apiKey, headers),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`interactions ${r.status}: ${detail.slice(0, 400)}`);
  }
  const json = (await r.json()) as {
    steps?: GoogleInteractionStep[];
  };
  const image = json.steps
    ?.find((step) => step.type === "model_output")
    ?.content?.find((c) => c.type === "image" && c.data);
  if (!image?.data) {
    throw new Error("interactions response did not contain an output image");
  }
  return {
    data: [
      {
        b64_json: image.data,
        mime_type: image.mime_type ?? "image/png",
      },
    ],
  };
}

export type PainterFallbackResult = {
  readonly json: unknown;
  readonly usedModel: string | undefined;
  readonly errors: readonly string[];
};

/**
 * Tries each model candidate in order for image generation/edit, returning the
 * first successful response. Exported for tests.
 */
export async function runPainterFallback(
  registry: ModelRegistry,
  candidates: readonly Model<Api>[],
  mode: "generate" | "edit",
  prompt: string,
  inputs: readonly string[],
  size: string,
  quality: string,
  signal: AbortSignal | undefined
): Promise<PainterFallbackResult> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    let resolved: ResolvedModel;
    try {
      resolved = await ModelResolver.resolveAuth(registry, candidate);
    } catch (err) {
      errors.push(
        `auth for "${candidate.provider}/${candidate.id}": ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    try {
      let json: unknown;
      if (resolved.model.api === "google-generative-ai") {
        json = await callGoogleInteraction(resolved, prompt, inputs, signal);
      } else if (mode === "edit") {
        json = await callEdit(resolved, prompt, inputs, size, quality, signal);
      } else {
        json = await callGenerate(resolved, prompt, size, quality, signal);
      }
      return {
        json,
        usedModel: `${candidate.provider}/${candidate.id}`,
        errors,
      };
    } catch (err) {
      errors.push(
        `painter model "${candidate.provider}/${candidate.id}": ${requestError(err)}`
      );
      if (signal?.aborted) {
        break;
      }
    }
  }
  return { json: undefined, usedModel: undefined, errors };
}

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "painter",
    label: "painter",
    description:
      "Generate or edit images. Use mode='generate' for text→image (mockups, icons, hero images, diagrams) " +
      "and mode='edit' with 1-3 input images for edits, compositing, or redaction " +
      "(e.g. blur API keys/passwords in screenshots). Saves a PNG and renders it inline.",
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
            "Defaults to 'edit' when `input` is provided, else 'generate'.",
        })
      ),
      input: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "1-3 input image paths for edit mode (redaction, style edit, reference-guided generation).",
        })
      ),
      size: Type.Optional(
        Type.Union(
          [
            Type.Literal("1024x1024"),
            Type.Literal("1792x1024"),
            Type.Literal("1024x1792"),
          ],
          { description: "Output size. Default 1024x1024." }
        )
      ),
      quality: Type.Optional(
        Type.Union(
          [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
          { description: "Output quality. Default medium." }
        )
      ),
      output_path: Type.Optional(
        Type.String({
          description: "Output PNG path. Default ./painter-<timestamp>.png",
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
      ).filter(
        (m) =>
          m.api === "openai-completions" || m.api === "google-generative-ai"
      );
      if (candidates.length === 0) {
        return errResult(
          `painter: no model "${modelRef}" using api "openai-completions" or "google-generative-ai" found in any configured provider. ` +
            `Set painter.model in ~/.pim/settings.json to an available image model.`
        );
      }

      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) {
        return errResult("painter: `prompt` is required");
      }

      const inputs: string[] = Array.isArray(args.input)
        ? args.input.filter((p) => typeof p === "string" && p.length > 0)
        : [];
      const mode = args.mode ?? (inputs.length > 0 ? "edit" : "generate");
      const size = args.size ?? "1024x1024";
      const quality = args.quality ?? "medium";

      if (mode === "edit" && inputs.length === 0) {
        return errResult(
          "painter: edit mode requires at least one `input` image path"
        );
      }
      for (const p of inputs) {
        if (!(await Bun.file(p).exists())) {
          return errResult(`painter: input image not readable: "${p}"`);
        }
      }

      if (signal?.aborted) {
        throw new Error("painter aborted before execution.");
      }
      const activeSignal = requestSignal(signal);

      const outcome = await runPainterFallback(
        ctx.modelRegistry,
        candidates,
        mode,
        prompt,
        inputs,
        size,
        quality,
        activeSignal
      );
      if (outcome.json === undefined) {
        return errResult(
          `painter: all model candidates failed. ${outcome.errors.join(" | ")}`
        );
      }
      const json = outcome.json;

      const item = (
        json as {
          data?: Array<{ b64_json?: string; url?: string; mime_type?: string }>;
        }
      )?.data?.[0];
      if (!item) {
        return errResult(
          `painter: no data in response (${JSON.stringify(json).slice(0, 200)})`
        );
      }

      const mimeType = item.mime_type ?? "image/png";
      let b64: string | undefined = item.b64_json;
      let bytes: Buffer;
      if (b64) {
        bytes = Buffer.from(b64, "base64");
      } else if (item.url) {
        const r = await fetch(item.url, { signal: activeSignal });
        if (!r.ok) {
          return errResult(
            `painter: download generated image failed (${r.status})`
          );
        }
        bytes = Buffer.from(await r.arrayBuffer());
        b64 = bytes.toString("base64");
      } else {
        return errResult("painter: response had neither b64_json nor url");
      }

      const outPath =
        String(args.output_path ?? "").trim() ||
        Paths.resolve(defaultOutputPath(), ctx.cwd);

      try {
        await Bun.write(outPath, bytes);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errResult(
          `painter: generated image but failed to write "${outPath}": ${msg}`
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `painter ${mode} → ${outPath}  (${size}, ${quality}, ${(bytes.length / 1024).toFixed(0)} KB)`,
          },
          { type: "image" as const, data: b64, mimeType: mimeType },
        ],
        details: {
          path: outPath,
          mode,
          size,
          quality,
          bytes: bytes.length,
          model: outcome.usedModel,
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
