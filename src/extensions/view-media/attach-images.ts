import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Paths } from "../../shared/Paths";

// Formats every image-capable provider accepts inline.
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

type ImageResizeOptions = NonNullable<Parameters<typeof resizeImage>[2]>;

const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

// Absolute or ~ paths only: pi pastes clipboard images and terminals drop
// files as absolute paths, while a bare relative name in prose is too easy to
// match by accident. Quoted and backslash-escaped forms cover drag-and-drop.
const PATH_PATTERN =
  /(?<=^|[\s([])(?:'(~?\/[^']+)'|"(~?\/[^"]+)"|((?:~\/|\/)(?:\\.|[^\s'"])+))/g;

const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

export type AttachedImages = {
  readonly text: string;
  readonly images: readonly ImageContent[];
};

export function findImagePaths(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw =
      match[1] ??
      match[2] ??
      (match[3] ?? "")
        .replace(TRAILING_PUNCTUATION, "")
        .replace(/\\(.)/g, "$1");
    if (imageMime(raw)) {
      found.add(raw);
    }
  }
  return [...found];
}

function imageMime(path: string): string | undefined {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? IMAGE_MIME[ext] : undefined;
}

/**
 * Turns image paths in a prompt into image attachments so an image-capable
 * model sees the pixels directly instead of spending a `view_media` call.
 * `resize` is for queued steer/follow-up messages, which pi does not run
 * through the model's image limits the way it does a fresh prompt.
 */
export async function attachImagePaths(
  text: string,
  cwd: string,
  resize?: ImageResizeOptions
): Promise<AttachedImages> {
  const images: ImageContent[] = [];
  const attached: string[] = [];
  for (const rawPath of findImagePaths(text)) {
    const absPath = Paths.resolve(rawPath, cwd);
    const file = Bun.file(absPath);
    if (
      !(await file.exists()) ||
      file.size === 0 ||
      file.size > MAX_ATTACH_BYTES
    ) {
      continue;
    }
    const mimeType = imageMime(absPath) as string;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const resized = resize
      ? await resizeImage(bytes, mimeType, resize).catch(() => null)
      : null;
    images.push(
      resized?.wasResized
        ? { type: "image", data: resized.data, mimeType: resized.mimeType }
        : {
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType,
          }
    );
    attached.push(rawPath);
  }
  if (images.length === 0) {
    return { text, images };
  }
  const notes = attached.map((p) => `[Image attached: ${p}]`).join("\n");
  return { text: `${text}\n\n${notes}`, images };
}
