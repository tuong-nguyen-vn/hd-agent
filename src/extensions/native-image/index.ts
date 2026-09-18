import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { convertToPng as ConvertToPng } from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
  Container,
  getCapabilities,
  Image,
  Text,
} from "@earendil-works/pi-tui";
import {
  type CapturedImage,
  NativeImageCapture,
} from "../../shared/NativeImageCapture";
import { Paths } from "../../shared/Paths";
import { PimSettings } from "../../shared/PimSettings";

const CUSTOM_TYPE = "native-image";
const IMAGE_WIDTH_CELLS = 60;
const PAINTER_TOOL = "painter";
/** Fills an assistant turn that was nothing but an image, so it isn't blank. */
const IMAGE_ONLY_REPLY = "🖼️ Image generated (shown below).";

const MIME_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

type NativeImageDetails = {
  readonly path: string;
  readonly model: string;
  readonly bytes: number;
  /** PNG copy for kitty, whose graphics protocol only takes PNG. */
  readonly preview?: ImageContent;
};

/**
 * A model paints natively when the user allows it, the model is on the
 * allow-list, and its provider streams through the image tee — without the
 * tee the tool would still run server-side but the bytes would never arrive.
 */
export async function isNativeImageModel(
  model: Model<Api> | undefined
): Promise<boolean> {
  if (
    !model ||
    model.api !== "openai-completions" ||
    !NativeImageCapture.hasTee(model.provider)
  ) {
    return false;
  }
  if (!(await PimSettings.getNativeImageGenEnabled())) {
    return false;
  }
  const allowed = await PimSettings.getNativeImageGenModels();
  return allowed.includes(model.id.toLowerCase());
}

async function kittyPreview(
  image: CapturedImage
): Promise<ImageContent | undefined> {
  if (getCapabilities().images !== "kitty" || image.mimeType === "image/png") {
    return undefined;
  }
  const { convertToPng } =
    (await import("@earendil-works/pi-coding-agent")) as {
      convertToPng: typeof ConvertToPng;
    };
  const converted = await convertToPng(image.data, image.mimeType).catch(
    () => null
  );
  return converted
    ? { type: "image", data: converted.data, mimeType: converted.mimeType }
    : undefined;
}

/**
 * Writes a captured image next to the session's cwd; returns its path. The
 * name carries milliseconds and a counter suffix, so a batch of images from
 * one turn never overwrites itself.
 */
export async function saveCapturedImage(
  cwd: string,
  image: CapturedImage,
  now: Date = new Date()
): Promise<{ readonly path: string; readonly bytes: number }> {
  const bytes = Buffer.from(image.data, "base64");
  const ext = MIME_EXT[image.mimeType] ?? "png";
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 23);
  let path = Paths.resolve(`image-${stamp}.${ext}`, cwd);
  for (let n = 2; await Bun.file(path).exists(); n++) {
    path = Paths.resolve(`image-${stamp}-${n}.${ext}`, cwd);
  }
  await Bun.write(path, bytes);
  return { path, bytes: bytes.length };
}

/**
 * Saves a captured image and posts it back into the session as a custom
 * message: pi renders it through the renderer below and feeds it to the
 * model as a user-role image on the next request, the same path an image
 * pasted into the prompt takes.
 */
async function publish(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  image: CapturedImage
): Promise<void> {
  const { path, bytes } = await saveCapturedImage(ctx.cwd, image);
  const preview = await kittyPreview(image);
  pi.sendMessage<NativeImageDetails>(
    {
      customType: CUSTOM_TYPE,
      content: [
        { type: "image", data: image.data, mimeType: image.mimeType },
        {
          type: "text",
          text: `[native image] ${image.model} generated this image in its previous reply; saved to ${path}.`,
        },
      ],
      display: true,
      details: {
        path,
        model: image.model,
        bytes,
        ...(preview ? { preview } : {}),
      },
    },
    { triggerTurn: false }
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasText(content: readonly { type: string; text?: string }[]): boolean {
  return content.some(
    (block) => block.type === "text" && (block.text ?? "").trim().length > 0
  );
}

function firstImage(
  content: string | readonly { type: string }[]
): ImageContent | undefined {
  if (typeof content === "string") {
    return undefined;
  }
  return content.find((block): block is ImageContent => block.type === "image");
}

export default function (pi: ExtensionAPI): void {
  let painterHiddenHere = false;

  pi.registerMessageRenderer<NativeImageDetails>(
    CUSTOM_TYPE,
    (message, options, theme) => {
      const container = new Container();
      const details = message.details;
      const label = details
        ? `${details.model} → ${Paths.abbreviateHome(details.path)}`
        : CUSTOM_TYPE;
      container.addChild(
        new Text(
          theme.fg("accent", "🖼 ") + theme.fg("muted", label),
          options.outputPad,
          0
        )
      );
      const image = details?.preview ?? firstImage(message.content);
      if (image) {
        container.addChild(
          new Image(
            image.data,
            image.mimeType,
            { fallbackColor: (s: string) => theme.fg("muted", s) },
            { maxWidthCells: IMAGE_WIDTH_CELLS }
          )
        );
      }
      return container;
    }
  );

  pi.on("before_provider_request", async (event, ctx) => {
    const model = ctx.model;
    if (!model || !(await isNativeImageModel(model))) {
      return undefined;
    }
    return NativeImageCapture.injectImageTool(event.payload, model.id);
  });

  pi.on("turn_start", (_event, ctx) => {
    NativeImageCapture.drain(ctx.sessionManager.getSessionId());
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    const sessionId = ctx.sessionManager.getSessionId();
    if (
      message.role !== "assistant" ||
      NativeImageCapture.peek(sessionId).length === 0
    ) {
      return undefined;
    }
    if (ctx.hasUI) {
      // The image follows as its own message; only an image-only reply needs
      // a line so the turn doesn't render blank.
      return hasText(message.content)
        ? undefined
        : {
            message: {
              ...message,
              content: [
                ...message.content,
                { type: "text", text: IMAGE_ONLY_REPLY },
              ],
            },
          };
    }
    // Print mode and other headless runs only surface the assistant's own
    // text (and stop printing if anything follows it), so the saved paths go
    // into the reply and nothing is queued behind it.
    const lines: string[] = [];
    for (const image of NativeImageCapture.drain(sessionId)) {
      try {
        const { path } = await saveCapturedImage(ctx.cwd, image);
        lines.push(`🖼️ Image saved to ${path}`);
      } catch (err) {
        lines.push(`🖼️ Image could not be saved: ${errorMessage(err)}`);
      }
    }
    return {
      message: {
        ...message,
        content: [...message.content, { type: "text", text: lines.join("\n") }],
      },
    };
  });

  pi.on("turn_end", async (_event, ctx) => {
    for (const image of NativeImageCapture.drain(
      ctx.sessionManager.getSessionId()
    )) {
      try {
        await publish(pi, ctx, image);
      } catch (err) {
        // One bad write must not swallow the rest of the batch; leave a
        // trace in the transcript instead of losing the image silently.
        pi.sendMessage(
          {
            customType: CUSTOM_TYPE,
            content: `[native image] ${image.model} generated an image but it could not be saved: ${errorMessage(err)}`,
            display: true,
          },
          { triggerTurn: false }
        );
      }
    }
  });

  // One image tool at a time: painter steps aside while the main model can
  // paint on its own, and comes back when the user switches to one that can't.
  const syncPainter = async (model: Model<Api> | undefined): Promise<void> => {
    const native = await isNativeImageModel(model);
    const active = pi.getActiveTools();
    const visible = active.includes(PAINTER_TOOL);
    if (native) {
      if (visible) {
        pi.setActiveTools(active.filter((name) => name !== PAINTER_TOOL));
        painterHiddenHere = true;
      }
      return;
    }
    // Leaving native mode: restore painter only if this extension is the
    // one that hid it, and forget the claim either way so a user's own
    // /tools choice afterwards is left alone.
    if (!visible && painterHiddenHere) {
      pi.setActiveTools([...active, PAINTER_TOOL]);
    }
    painterHiddenHere = false;
  };

  pi.on("session_start", async (_event, ctx) => {
    await syncPainter(ctx.model);
  });

  pi.on("model_select", async (event) => {
    await syncPainter(event.model);
  });
}
