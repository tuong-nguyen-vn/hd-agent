import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getCapabilities, Image } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ModelResolver, type ResolvedModel } from "../../shared/ModelResolver";
import { Paths } from "../../shared/Paths";
import { PimSettings } from "../../shared/PimSettings";
import {
  Renderer,
  type StatefulToolCallTitleContext,
} from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";

const PREVIEW_LINES = 5;

const IMAGE_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

type ViewMediaInput = {
  readonly path: string;
  readonly question?: string;
};

type ViewMediaDetails = {
  readonly isError?: boolean;
  readonly mimeType?: string;
  readonly bytes?: number;
  readonly source?: "direct" | "vision-fallback";
  readonly visionModel?: string;
  /** Base64 image data for terminal-only preview. Never sent to the model. */
  readonly previewData?: string;
  /** Mime type of `previewData` (may differ from `mimeType` if converted for Kitty). */
  readonly previewMimeType?: string;
};

type ViewMediaRenderContext = StatefulToolCallTitleContext & {
  readonly args?: Partial<ViewMediaInput>;
  readonly cwd: string;
};

function mimeFromPath(p: string): string | undefined {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m?.[1] ? IMAGE_EXT[m[1]] : undefined;
}

function modelSupportsImages(model: unknown): boolean {
  return (
    !!model &&
    typeof model === "object" &&
    Array.isArray((model as { input?: unknown[] }).input) &&
    (model as { input: unknown[] }).input.includes("image")
  );
}

function errResult(text: string): AgentToolResult<ViewMediaDetails> {
  return {
    content: [{ type: "text", text }],
    details: { isError: true },
  };
}

/**
 * Prepare base64 image data for terminal-only preview. Kitty's graphics
 * protocol hard-codes PNG (`f=100`), so non-PNG images must be converted or
 * they render as garbage. Other protocols (iTerm2, sixel) accept the raw
 * bytes as-is.
 */
async function buildPreview(
  base64: string,
  mimeType: string
): Promise<{ data: string; mimeType: string }> {
  if (mimeType === "image/png" || getCapabilities().images !== "kitty") {
    return { data: base64, mimeType };
  }
  const converted = await convertToPng(base64, mimeType).catch(() => null);
  return converted ?? { data: base64, mimeType };
}

function renderTitle(
  args: Partial<ViewMediaInput> | undefined,
  theme: Theme,
  context: ViewMediaRenderContext
) {
  const rawPath = args?.path ?? "";
  const absPath = rawPath ? Paths.resolve(rawPath, context.cwd) : "";
  const basename = rawPath
    ? (Paths.toForwardSlashes(rawPath).split("/").pop() ?? rawPath)
    : "...";
  const title = absPath
    ? Renderer.renderFileLink(theme, basename, absPath)
    : "...";
  const markerColor = Renderer.markerColorFor(
    Boolean(context.isPartial),
    Boolean(context.isError)
  );
  return Renderer.renderStatefulToolCallTitle({
    label: "view_media",
    title,
    theme,
    context,
    markerGlyph: Renderer.markerGlyphFor(markerColor),
    separator: " ",
    useSpinner: true,
  });
}

function filterNullHeaders(
  headers: Record<string, string | null> | undefined
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (v !== null) {
      filtered[k] = v;
    }
  }
  return filtered;
}

async function describeWithVision(
  resolved: ResolvedModel,
  base64: string,
  mimeType: string,
  question: string,
  signal: AbortSignal | undefined
): Promise<{ description: string; model: string }> {
  const { model, apiKey, headers } = resolved;
  const api = model.api;
  const base = model.baseUrl;
  const prompt =
    question?.trim() ||
    "Describe this image concisely: key objects, text (OCR), colors, layout. Be factual and specific.";

  if (api === "google-generative-ai") {
    return await describeWithGoogle(
      base,
      apiKey,
      model.id,
      base64,
      mimeType,
      prompt,
      signal,
      headers
    );
  }
  if (api === "anthropic-messages") {
    return await describeWithAnthropic(
      base,
      apiKey,
      model.id,
      base64,
      mimeType,
      prompt,
      signal,
      headers
    );
  }
  if (api !== "openai-completions") {
    throw new Error(
      `view_media: unsupported API protocol "${api}" for vision fallback`
    );
  }

  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...filterNullHeaders(headers),
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `vision fallback model "${model.id}" at ${base}/chat/completions returned ${resp.status}: ${detail.slice(0, 300)}`
    );
  }

  const data = (await resp.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };
  const content = data?.choices?.[0]?.message?.content;
  const description = Array.isArray(content)
    ? content
        .map((c) => (typeof c === "string" ? c : (c?.text ?? "")))
        .filter(Boolean)
        .join("\n")
        .trim()
    : (typeof content === "string" ? content : "").trim();
  return { description, model: model.id };
}

async function describeWithGoogle(
  base: string,
  key: string | undefined,
  model: string,
  base64: string,
  mimeType: string,
  prompt: string,
  signal: AbortSignal | undefined,
  extraHeaders?: Record<string, string | null>
): Promise<{ description: string; model: string }> {
  const endpoint = `${base}/models/${encodeURIComponent(model)}:generateContent`;
  const resp = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-goog-api-key": key, authorization: `Bearer ${key}` } : {}),
      ...filterNullHeaders(extraHeaders),
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }],
        },
      ],
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `vision fallback model "${model}" at ${endpoint} returned ${resp.status}: ${detail.slice(0, 300)}`
    );
  }
  const data = (await resp.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const description = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  return { description, model };
}

async function describeWithAnthropic(
  base: string,
  key: string | undefined,
  model: string,
  base64: string,
  mimeType: string,
  prompt: string,
  signal: AbortSignal | undefined,
  extraHeaders?: Record<string, string | null>
): Promise<{ description: string; model: string }> {
  const endpoint = `${base.endsWith("/v1") ? base : `${base}/v1`}/messages`;
  const resp = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(key ? { "x-api-key": key, authorization: `Bearer ${key}` } : {}),
      ...filterNullHeaders(extraHeaders),
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: base64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `vision fallback model "${model}" at ${endpoint} returned ${resp.status}: ${detail.slice(0, 300)}`
    );
  }
  const data = (await resp.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const description = (data.content ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  return { description, model };
}

/**
 * Tries each model candidate in order, returning a vision-fallback result for
 * the first one that succeeds. Returns undefined when no candidate is
 * usable (so the caller can fall back to the main model). Exported for tests.
 */
export async function runVisionFallback(
  registry: ModelRegistry,
  candidates: readonly Model<Api>[],
  base64: string,
  mimeType: string,
  bytes: number,
  question: string,
  signal: AbortSignal | undefined,
  _modelRef: string
): Promise<AgentToolResult<ViewMediaDetails> | undefined> {
  for (const candidate of candidates) {
    if (!candidate.input.includes("image")) {
      continue;
    }
    let resolved: ResolvedModel;
    try {
      resolved = await ModelResolver.resolveAuth(registry, candidate);
    } catch {
      continue;
    }

    try {
      const { description, model: visionModel } = await describeWithVision(
        resolved,
        base64,
        mimeType,
        question,
        signal
      );
      const preview = await buildPreview(base64, mimeType);
      return {
        content: [{ type: "text" as const, text: description }],
        details: {
          mimeType,
          bytes,
          source: "vision-fallback" as const,
          visionModel,
          previewData: preview.data,
          previewMimeType: preview.mimeType,
        } satisfies ViewMediaDetails,
      };
    } catch {
      if (signal?.aborted) {
        break;
      }
    }
  }
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  Tools.register(pi, {
    name: "view_media",
    label: "view_media",
    description:
      "View an image file. Renders it inline in the terminal and returns a description. " +
      "Use this for screenshots, diagrams, photos, mockups, or any image the user references. " +
      "Uses the configured view_media model to describe the image; tries comma-separated fallback models then falls back to the current model if all fail.",
    promptSnippet: "View an image file",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the image file (relative or absolute)",
      }),
      question: Type.Optional(
        Type.String({
          description:
            "Optional question or focus for analysis (e.g. 'Read all text', 'Identify the error dialog'). " +
            "If omitted, a general description is produced.",
        })
      ),
    }),
    renderShell: "self",
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = params as ViewMediaInput;
      const absPath = Paths.resolve(args.path, ctx.cwd);

      const mimeType = mimeFromPath(absPath);
      if (!mimeType) {
        return errResult(
          `view_media: unsupported file type for "${args.path}". Supported: ${Object.keys(IMAGE_EXT).join(", ")}.`
        );
      }

      if (!(await Bun.file(absPath).exists())) {
        return errResult(`view_media: file not found: "${args.path}"`);
      }

      if (signal?.aborted) {
        throw new Error("view_media aborted before execution.");
      }

      const buffer = Buffer.from(await Bun.file(absPath).arrayBuffer());
      const base64 = buffer.toString("base64");

      const imageBlock = {
        type: "image" as const,
        data: base64,
        mimeType,
      };

      const directToModel = await PimSettings.getViewMediaDirectToModel();
      if (directToModel) {
        const preview = await buildPreview(base64, mimeType);
        if (!modelSupportsImages(ctx.model)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "view_media: direct-to-model mode is enabled but the current model cannot read images. Run /vision-direct to switch back to vision fallback.",
              },
            ],
            details: {
              isError: true,
              mimeType,
              bytes: buffer.length,
              previewData: preview.data,
              previewMimeType: preview.mimeType,
            } satisfies ViewMediaDetails,
          };
        }
        const note = args.question?.trim()
          ? `The image is attached (question: ${args.question.trim()}).`
          : "The image is attached.";
        return {
          content: [{ type: "text" as const, text: note }, imageBlock],
          details: {
            mimeType,
            bytes: buffer.length,
            source: "direct" as const,
            previewData: preview.data,
            previewMimeType: preview.mimeType,
          } satisfies ViewMediaDetails,
        };
      }

      const fallbackToMainModel = async (reason: string) => {
        const supportsImages = modelSupportsImages(ctx.model);
        if (!supportsImages) {
          const preview = await buildPreview(base64, mimeType);
          return {
            content: [
              {
                type: "text" as const,
                text: `view_media: ${reason} Current model cannot read images either.`,
              },
            ],
            details: {
              isError: true,
              mimeType,
              bytes: buffer.length,
              previewData: preview.data,
              previewMimeType: preview.mimeType,
            } satisfies ViewMediaDetails,
          };
        }
        const note = args.question?.trim()
          ? `The image is attached (question: ${args.question.trim()}).`
          : "The image is attached.";
        const preview = await buildPreview(base64, mimeType);
        return {
          content: [
            {
              type: "text" as const,
              text: `${reason} Falling back to the current model. ${note}`,
            },
            imageBlock,
          ],
          details: {
            mimeType,
            bytes: buffer.length,
            source: "direct" as const,
            previewData: preview.data,
            previewMimeType: preview.mimeType,
          } satisfies ViewMediaDetails,
        };
      };

      const modelRef = await PimSettings.getViewMediaModel();
      const candidates = await ModelResolver.resolveCandidates(
        ctx.modelRegistry,
        modelRef,
        ctx.model?.provider
      );

      const result = await runVisionFallback(
        ctx.modelRegistry,
        candidates,
        base64,
        mimeType,
        buffer.length,
        args.question ?? "",
        signal,
        modelRef
      );
      if (result !== undefined) {
        return result;
      }

      return await fallbackToMainModel(
        `view_media: configured model "${modelRef}" not found in any provider in ~/.pi/agent/models.json.`
      );
    },
    renderCall(args, theme, context) {
      return renderTitle(
        (args ?? {}) as Partial<ViewMediaInput>,
        theme,
        context as ViewMediaRenderContext
      );
    },
    renderResult(result, options, theme, context) {
      const ctx = context as ViewMediaRenderContext;
      renderTitle(ctx.args ?? {}, theme, ctx);

      const details = result.details as ViewMediaDetails | undefined;
      const container = details?.isError
        ? Renderer.renderBorderedResult({
            result,
            options,
            theme,
            context: ctx,
            previewLines: PREVIEW_LINES,
            prefix: { prefix: "   ", width: 3 },
          })
        : Renderer.renderBorderedResult({
            result,
            options,
            theme,
            context: ctx,
            previewLines: PREVIEW_LINES,
            prefix: { prefix: "   ", width: 3 },
            showCollapsedSuccess: true,
          });

      const previewMimeType = details?.previewMimeType ?? details?.mimeType;
      if (details?.previewData && previewMimeType && !options.isPartial) {
        container.addChild(
          new Image(details.previewData, previewMimeType, {
            fallbackColor: (s: string) => theme.fg("toolOutput", s),
          })
        );
        container.invalidate();
      }

      return container;
    },
  });

  pi.registerCommand("vision-direct", {
    description:
      "Toggle direct-to-model mode, or force with /vision-direct true|false",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      const current = await PimSettings.getViewMediaDirectToModel();
      let next: boolean;
      if (arg === "true" || arg === "false") {
        next = arg === "true";
      } else if (arg === "") {
        next = !current;
      } else {
        ctx.ui.notify("Usage: /vision-direct [true|false]", "error");
        return;
      }
      if (next && !modelSupportsImages(ctx.model)) {
        ctx.ui.notify(
          "Cannot enable direct-to-model: current model does not support image input",
          "error"
        );
        return;
      }
      const viewMedia = await PimSettings.get("viewMedia");
      await PimSettings.set("viewMedia", { ...viewMedia, directToModel: next });
      ctx.ui.notify(
        next
          ? "Direct-to-model enabled — images sent to the main model"
          : "Vision fallback enabled — images described by a vision model",
        "info"
      );
    },
  });
}
