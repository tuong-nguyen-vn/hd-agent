import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelImage, saveCapturedImage } from "./index";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "native-image-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("saveCapturedImage", () => {
  test("writes the bytes under cwd with a timestamped name and the mime's extension", async () => {
    const now = new Date("2026-09-14T08:21:19.123Z");
    const saved = await saveCapturedImage(
      dir,
      { data: PNG_B64, mimeType: "image/jpeg", model: "gpt-5.6-luna" },
      now
    );

    expect(saved.path).toBe(join(dir, "image-2026-09-14T08-21-19-123.jpg"));
    expect(saved.bytes).toBe(Buffer.from(PNG_B64, "base64").length);
    expect(await Bun.file(saved.path).exists()).toBe(true);
    expect(Buffer.from(await Bun.file(saved.path).arrayBuffer())).toEqual(
      Buffer.from(PNG_B64, "base64")
    );
  });

  test("falls back to png for unknown mime types", async () => {
    const saved = await saveCapturedImage(
      dir,
      { data: PNG_B64, mimeType: "image/x-unknown", model: "m" },
      new Date("2026-01-01T00:00:00.000Z")
    );
    expect(saved.path.endsWith("image-2026-01-01T00-00-00-000.png")).toBe(true);
  });

  test("never overwrites an earlier image from the same millisecond", async () => {
    const now = new Date("2026-02-02T02:02:02.002Z");
    const image = { data: PNG_B64, mimeType: "image/jpeg", model: "m" };
    const first = await saveCapturedImage(dir, image, now);
    const second = await saveCapturedImage(dir, image, now);
    const third = await saveCapturedImage(dir, image, now);
    expect(first.path.endsWith("image-2026-02-02T02-02-02-002.jpg")).toBe(true);
    expect(second.path.endsWith("image-2026-02-02T02-02-02-002-2.jpg")).toBe(
      true
    );
    expect(third.path.endsWith("image-2026-02-02T02-02-02-002-3.jpg")).toBe(
      true
    );
  });
});

/** A noisy PNG, so the encoder cannot collapse it below a byte cap. */
async function noisyPng(size: number): Promise<string> {
  const photon = await import("@silvia-odwyer/photon-node");
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels.set([(i * 7) % 251, (i * 13) % 241, (i * 29) % 239, 255], i);
  }
  const image = new photon.PhotonImage(pixels, size, size);
  try {
    return Buffer.from(image.get_bytes()).toString("base64");
  } finally {
    image.free();
  }
}

function modelWith(
  resize: { maxWidth: number; maxHeight: number; maxBytes: number } | undefined
): Model<Api> {
  return {
    id: "m",
    name: "m",
    api: "openai-completions",
    provider: "p",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...(resize ? { inputLimits: { images: { resize } } } : {}),
  };
}

describe("modelImage", () => {
  test("passes the original through when the model declares no limits", async () => {
    const image = { data: PNG_B64, mimeType: "image/png", model: "x" };
    expect(await modelImage(image, modelWith(undefined))).toEqual({
      type: "image",
      data: PNG_B64,
      mimeType: "image/png",
    });
    expect(await modelImage(image, undefined)).toMatchObject({ data: PNG_B64 });
  });

  test("re-encodes to the model's byte cap without changing pixels", async () => {
    const data = await noisyPng(256);
    const model = modelWith({
      maxWidth: 512,
      maxHeight: 512,
      maxBytes: 64 * 1024,
    });

    const sent = await modelImage(
      { data, mimeType: "image/png", model: "x" },
      model
    );

    expect(data.length).toBeGreaterThan(64 * 1024);
    expect(sent.data.length).toBeLessThan(64 * 1024);
    expect(sent.mimeType).toBe("image/jpeg");
    const photon = await import("@silvia-odwyer/photon-node");
    const decoded = photon.PhotonImage.new_from_byteslice(
      new Uint8Array(Buffer.from(sent.data, "base64"))
    );
    expect([decoded.get_width(), decoded.get_height()]).toEqual([256, 256]);
    decoded.free();
  });
});
