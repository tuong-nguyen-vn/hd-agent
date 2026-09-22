import { expect, test } from "bun:test";
import { getPngDimensions } from "@earendil-works/pi-tui";
import { IndexedPng } from "./IndexedPng";

async function decode(
  png: Uint8Array
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const photon = await import("@silvia-odwyer/photon-node");
  const image = photon.PhotonImage.new_from_byteslice(png);
  try {
    return {
      pixels: image.get_raw_pixels(),
      width: image.get_width(),
      height: image.get_height(),
    };
  } finally {
    image.free();
  }
}

function chunkLength(png: Uint8Array, type: string): number | undefined {
  for (let at = 8; at + 8 <= png.length; ) {
    const length = new DataView(png.buffer, png.byteOffset + at).getUint32(0);
    const name = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (name === type) {
      return length;
    }
    at += 12 + length;
  }
  return undefined;
}

function gradient(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      rgba[at] = Math.round((255 * x) / (width - 1));
      rgba[at + 1] = Math.round((255 * y) / (height - 1));
      rgba[at + 2] = 128;
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

test("round-trips an image of at most 256 colours exactly", async () => {
  const width = 16;
  const height = 16;
  const rgba = new Uint8Array(width * height * 4);
  // 256 colours at least 8 apart per channel, so each lands in its own
  // histogram cell and the palette reproduces it exactly.
  for (let i = 0; i < width * height; i++) {
    rgba.set([(i % 32) * 8, Math.floor(i / 32) * 32, 64, 255], i * 4);
  }

  const png = IndexedPng.encode(rgba, width, height);
  const decoded = await decode(png);

  expect(getPngDimensions(Buffer.from(png).toString("base64"))).toEqual({
    widthPx: width,
    heightPx: height,
  });
  expect(decoded.pixels).toEqual(rgba);
  expect(chunkLength(png, "tRNS")).toBeUndefined();
});

test("quantises a gradient to a palette with small error", async () => {
  const width = 200;
  const height = 120;
  const rgba = gradient(width, height);

  const png = IndexedPng.encode(rgba, width, height);
  const decoded = await decode(png);

  expect(png[25]).toBe(3);
  expect(chunkLength(png, "PLTE")).toBeLessThanOrEqual(256 * 3);
  let error = 0;
  for (let i = 0; i < rgba.length; i++) {
    error += Math.abs(decoded.pixels[i]! - rgba[i]!);
  }
  expect(error / rgba.length).toBeLessThan(8);
});

test("keeps transparency through a tRNS chunk", async () => {
  const rgba = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 255, 255, 255, 255,
  ]);

  const png = IndexedPng.encode(rgba, 2, 2);
  const decoded = await decode(png);

  expect(chunkLength(png, "tRNS")).toBeGreaterThan(0);
  expect(decoded.pixels).toEqual(rgba);
});

test("rejects a buffer that does not match the dimensions", () => {
  expect(() => IndexedPng.encode(new Uint8Array(7), 2, 1)).toThrow(
    "expected 8 RGBA bytes, got 7"
  );
});
