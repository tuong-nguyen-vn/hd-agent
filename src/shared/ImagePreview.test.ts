import { afterEach, expect, test } from "bun:test";
import {
  getPngDimensions,
  resetCapabilitiesCache,
  setCapabilities,
  setCellDimensions,
} from "@earendil-works/pi-tui";
import { ImagePreview } from "./ImagePreview";

const RGB = { maxWidthCells: 60, palette: false } as const;

afterEach(() => {
  resetCapabilitiesCache();
  setCellDimensions({ widthPx: 9, heightPx: 18 });
});

/** A noisy PNG, so the encoder cannot collapse it to a constant size. */
async function pngOf(width: number, height: number): Promise<string> {
  const photon = await import("@silvia-odwyer/photon-node");
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (i * 7) % 251;
    pixels[i + 1] = (i * 13) % 241;
    pixels[i + 2] = (i * 29) % 239;
    pixels[i + 3] = 255;
  }
  const image = new photon.PhotonImage(pixels, width, height);
  try {
    return Buffer.from(image.get_bytes()).toString("base64");
  } finally {
    image.free();
  }
}

function colorType(base64: string): number {
  return Buffer.from(base64, "base64")[25]!;
}

test("skips the preview when the terminal cannot draw images", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const png = await pngOf(1200, 1200);
  expect(await ImagePreview.build(png, "image/png", RGB)).toBeUndefined();
});

test("skips the preview when previews are turned off", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const png = await pngOf(1200, 1200);
  expect(
    await ImagePreview.build(png, "image/png", { ...RGB, maxWidthCells: 0 })
  ).toBeUndefined();
});

test("downscales a large image to the cells it is drawn in", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const png = await pngOf(1200, 900);

  const preview = await ImagePreview.build(png, "image/png", RGB);

  expect(preview?.mimeType).toBe("image/png");
  expect(preview?.widthCells).toBe(60);
  expect(getPngDimensions(preview!.data)).toEqual({
    widthPx: 540,
    heightPx: 405,
  });
  expect(preview!.data.length).toBeLessThan(png.length / 2);
});

test("quantises to a palette PNG when asked", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const png = await pngOf(1200, 900);

  const rgb = await ImagePreview.build(png, "image/png", RGB);
  const palette = await ImagePreview.build(png, "image/png", {
    ...RGB,
    palette: true,
  });

  // photon writes RGBA (colour type 6); the palette encoder writes type 3.
  expect(colorType(rgb!.data)).toBe(6);
  expect(colorType(palette!.data)).toBe(3);
  expect(getPngDimensions(palette!.data)).toEqual({
    widthPx: 540,
    heightPx: 405,
  });
  expect(palette!.data.length).toBeLessThan(rgb!.data.length);
});

test("scales to the terminal's reported cell width", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 14, heightPx: 30 });
  const png = await pngOf(1200, 1200);

  const preview = await ImagePreview.build(png, "image/png", RGB);

  expect(getPngDimensions(preview!.data)).toEqual({
    widthPx: 840,
    heightPx: 840,
  });
});

test("never shrinks below the floor for an unreported cell size", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const png = await pngOf(800, 800);

  const preview = await ImagePreview.build(png, "image/png", {
    ...RGB,
    maxWidthCells: 20,
  });

  expect(preview?.widthCells).toBe(20);
  expect(getPngDimensions(preview!.data)).toEqual({
    widthPx: 512,
    heightPx: 512,
  });
});

test("leaves an RGB image that already fits untouched", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const png = await pngOf(120, 90);

  const preview = await ImagePreview.build(png, "image/png", RGB);

  expect(preview).toEqual({ data: png, mimeType: "image/png", widthCells: 60 });
});

test("still palettises an image that already fits", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const png = await pngOf(120, 90);

  const preview = await ImagePreview.build(png, "image/png", {
    ...RGB,
    palette: true,
  });

  expect(colorType(preview!.data)).toBe(3);
  expect(getPngDimensions(preview!.data)).toEqual({
    widthPx: 120,
    heightPx: 90,
  });
});
