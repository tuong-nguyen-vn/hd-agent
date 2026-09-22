import { getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import { IndexedPng } from "./IndexedPng";

export type PreviewImage = {
  readonly data: string;
  readonly mimeType: string;
  /** Cell width the preview was sized for; pass it to the `Image` component. */
  readonly widthCells: number;
};

export type PreviewOptions = {
  readonly maxWidthCells: number;
  readonly palette: boolean;
};

/**
 * Never shrink below this, so a preview built before the terminal reported its
 * real cell size (pi-tui defaults to 9x18px) still looks sharp afterwards.
 */
const MIN_TARGET_PX = 512;

type Photon = typeof import("@silvia-odwyer/photon-node");
type PhotonImage = InstanceType<Photon["PhotonImage"]>;

let photonPromise: Promise<Photon | null> | undefined;

async function loadPhoton(): Promise<Photon | null> {
  photonPromise ??= import("@silvia-odwyer/photon-node").catch(() => null);
  return photonPromise;
}

function encodePng(image: PhotonImage, palette: boolean): Uint8Array {
  if (palette) {
    try {
      return IndexedPng.encode(
        image.get_raw_pixels(),
        image.get_width(),
        image.get_height()
      );
    } catch {
      // Fall through to photon's RGB encoder.
    }
  }
  return image.get_bytes();
}

/**
 * Terminal previews of model-generated images.
 *
 * A generated image is ~1000px square and several MB of base64, but the TUI
 * draws it inside a ~60-cell box — roughly 540px. Handing the full payload to
 * pi-tui's `Image` makes every frame that touches the image line rebuild,
 * rescan and re-place megabytes of escape sequence, and makes the terminal
 * decode the full-size PNG on each upload. Downscaling to the box the image is
 * actually drawn in cuts both by roughly the square of the ratio; a 256-colour
 * palette takes another ~3x off a photo-like PNG.
 */
export class ImagePreview {
  /** Longest edge, in pixels, that a `maxWidthCells`-wide box can show. */
  public static targetPixels(maxWidthCells: number): number {
    const cell = getCellDimensions();
    return Math.max(MIN_TARGET_PX, Math.round(maxWidthCells * cell.widthPx));
  }

  /**
   * Builds the smallest PNG that still fills the `maxWidthCells`-wide box, or
   * `undefined` when previews are off or the terminal cannot draw images at
   * all — callers then skip the preview instead of carrying a base64 blob
   * nothing will render. Falls back to the original bytes when the image
   * cannot be decoded.
   */
  public static async build(
    base64: string,
    mimeType: string,
    options: PreviewOptions
  ): Promise<PreviewImage | undefined> {
    const protocol = getCapabilities().images;
    if (!protocol || options.maxWidthCells <= 0) {
      return undefined;
    }
    const widthCells = options.maxWidthCells;
    const target = ImagePreview.targetPixels(widthCells);
    const encoded = await ImagePreview.reencode(
      base64,
      target,
      options.palette
    );
    if (encoded) {
      return { ...encoded, widthCells };
    }
    // Kitty's graphics protocol hard-codes PNG (`f=100`), so an unconverted
    // non-PNG image would render as garbage there; other protocols take the
    // raw bytes as-is.
    if (protocol !== "kitty" || mimeType === "image/png") {
      return { data: base64, mimeType, widthCells };
    }
    const converted = await ImagePreview.convertToPng(base64, mimeType);
    return converted ? { ...converted, widthCells } : undefined;
  }

  /**
   * Downscales to `targetPx` and re-encodes. Returns `undefined` when photon
   * is unavailable, the bytes cannot be decoded, or the image already fits the
   * box and needs no palette pass — the caller then keeps the original.
   */
  private static async reencode(
    base64: string,
    targetPx: number,
    palette: boolean
  ): Promise<Omit<PreviewImage, "widthCells"> | undefined> {
    const photon = await loadPhoton();
    if (!photon) {
      return undefined;
    }
    let source: PhotonImage | undefined;
    let scaled: PhotonImage | undefined;
    try {
      source = photon.PhotonImage.new_from_byteslice(
        new Uint8Array(Buffer.from(base64, "base64"))
      );
      const width = source.get_width();
      const height = source.get_height();
      const scale = targetPx / Math.max(width, height);
      if (!Number.isFinite(scale)) {
        return undefined;
      }
      if (scale >= 1 && !palette) {
        return undefined;
      }
      scaled =
        scale >= 1
          ? source
          : photon.resize(
              source,
              Math.max(1, Math.round(width * scale)),
              Math.max(1, Math.round(height * scale)),
              photon.SamplingFilter.Triangle
            );
      return {
        data: Buffer.from(encodePng(scaled, palette)).toString("base64"),
        mimeType: "image/png",
      };
    } catch {
      return undefined;
    } finally {
      if (scaled !== source) {
        scaled?.free();
      }
      source?.free();
    }
  }

  private static async convertToPng(
    base64: string,
    mimeType: string
  ): Promise<Omit<PreviewImage, "widthCells"> | undefined> {
    const { convertToPng } = await import("@earendil-works/pi-coding-agent");
    return (
      (await convertToPng(base64, mimeType).catch(() => null)) ?? undefined
    );
  }
}
