import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_COLORS = 256;
/** Histogram cell: 5 bits per RGB channel, 2 bits of alpha. */
const HIST_BITS = 5;
const HIST_ALPHA_BITS = 2;
const HIST_SIZE = 1 << (HIST_BITS * 3 + HIST_ALPHA_BITS);

type Box = {
  readonly cells: Int32Array;
  readonly start: number;
  readonly end: number;
  /** Widest channel of the box and its span; fixed until the box is split. */
  readonly channel: number;
  readonly range: number;
};

function histogramKey(r: number, g: number, b: number, a: number): number {
  const shift = 8 - HIST_BITS;
  let key = r >> shift;
  key = (key << HIST_BITS) | (g >> shift);
  key = (key << HIST_BITS) | (b >> shift);
  return (key << HIST_ALPHA_BITS) | (a >> (8 - HIST_ALPHA_BITS));
}

/**
 * Median cut over a histogram of the image's colours. Each box is a slice of
 * `cells`; the box with the widest channel span is split at that channel's
 * weighted median until there are `MAX_COLORS` boxes.
 */
function medianCut(
  count: Int32Array,
  mean: Float32Array,
  cells: Int32Array
): Uint8Array {
  const makeBox = (start: number, end: number): Box => {
    let channel = 0;
    let range = -1;
    for (let c = 0; c < 4; c++) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let k = start; k < end; k++) {
        const value = mean[cells[k]! * 4 + c]!;
        if (value < lo) {
          lo = value;
        }
        if (value > hi) {
          hi = value;
        }
      }
      if (hi - lo > range) {
        range = hi - lo;
        channel = c;
      }
    }
    return { cells, start, end, channel, range };
  };

  const boxes: Box[] = [makeBox(0, cells.length)];
  while (boxes.length < MAX_COLORS) {
    let widest = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.end - box.start < 2) {
        continue;
      }
      if (widest === -1 || box.range > boxes[widest]!.range) {
        widest = i;
      }
    }
    if (widest === -1) {
      break;
    }
    const box = boxes[widest]!;
    const channel = box.channel;
    cells
      .subarray(box.start, box.end)
      .sort((a, b) => mean[a * 4 + channel]! - mean[b * 4 + channel]!);
    let total = 0;
    for (let k = box.start; k < box.end; k++) {
      total += count[cells[k]!]!;
    }
    let acc = 0;
    let split = box.start;
    for (; split < box.end - 1; split++) {
      acc += count[cells[split]!]!;
      if (acc * 2 >= total) {
        split++;
        break;
      }
    }
    boxes[widest] = makeBox(box.start, split);
    boxes.push(makeBox(split, box.end));
  }

  const palette = new Uint8Array(boxes.length * 4);
  boxes.forEach((box, i) => {
    let n = 0;
    const acc = [0, 0, 0, 0];
    for (let k = box.start; k < box.end; k++) {
      const cell = cells[k]!;
      n += count[cell]!;
      for (let channel = 0; channel < 4; channel++) {
        acc[channel]! += mean[cell * 4 + channel]! * count[cell]!;
      }
    }
    for (let channel = 0; channel < 4; channel++) {
      palette[i * 4 + channel] = Math.round(acc[channel]! / n);
    }
  });
  return palette;
}

function buildPalette(rgba: Uint8Array): Uint8Array {
  const count = new Int32Array(HIST_SIZE);
  const sum = new Float64Array(HIST_SIZE * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const key = histogramKey(
      rgba[i]!,
      rgba[i + 1]!,
      rgba[i + 2]!,
      rgba[i + 3]!
    );
    count[key]!++;
    sum[key * 4]! += rgba[i]!;
    sum[key * 4 + 1]! += rgba[i + 1]!;
    sum[key * 4 + 2]! += rgba[i + 2]!;
    sum[key * 4 + 3]! += rgba[i + 3]!;
  }
  let used = 0;
  for (let key = 0; key < HIST_SIZE; key++) {
    if (count[key]! > 0) {
      used++;
    }
  }
  const cells = new Int32Array(used);
  const mean = new Float32Array(HIST_SIZE * 4);
  for (let key = 0, k = 0; key < HIST_SIZE; key++) {
    if (count[key]! === 0) {
      continue;
    }
    cells[k++] = key;
    for (let channel = 0; channel < 4; channel++) {
      mean[key * 4 + channel] = sum[key * 4 + channel]! / count[key]!;
    }
  }
  return medianCut(count, mean, cells);
}

function nearest(
  palette: Uint8Array,
  r: number,
  g: number,
  b: number,
  a: number
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i += 4) {
    const dr = palette[i]! - r;
    const dg = palette[i + 1]! - g;
    const db = palette[i + 2]! - b;
    const da = palette[i + 3]! - a;
    const distance = dr * dr + dg * dg + db * db + da * da;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i >> 2;
    }
  }
  return best;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Floyd–Steinberg dithering onto the palette. Nearest-colour lookups are
 * memoised on the histogram key, which bounds the 256-entry scans to the
 * number of distinct colours rather than the number of pixels.
 */
function dither(
  rgba: Uint8Array,
  width: number,
  height: number,
  palette: Uint8Array
): Uint8Array {
  const indices = new Uint8Array(width * height);
  const lookup = new Int16Array(HIST_SIZE).fill(-1);
  const pixels = new Float32Array(rgba);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const rowBelow = y + 1 < height;
    for (let x = 0; x < width; x++) {
      const at = y * stride + x * 4;
      const r = clamp(Math.round(pixels[at]!));
      const g = clamp(Math.round(pixels[at + 1]!));
      const b = clamp(Math.round(pixels[at + 2]!));
      const a = clamp(Math.round(pixels[at + 3]!));
      const key = histogramKey(r, g, b, a);
      let index = lookup[key]!;
      if (index === -1) {
        index = nearest(palette, r, g, b, a);
        lookup[key] = index;
      }
      indices[y * width + x] = index;
      const er = r - palette[index * 4]!;
      const eg = g - palette[index * 4 + 1]!;
      const eb = b - palette[index * 4 + 2]!;
      const ea = a - palette[index * 4 + 3]!;
      if (x + 1 < width) {
        const to = at + 4;
        pixels[to]! += (er * 7) / 16;
        pixels[to + 1]! += (eg * 7) / 16;
        pixels[to + 2]! += (eb * 7) / 16;
        pixels[to + 3]! += (ea * 7) / 16;
      }
      if (!rowBelow) {
        continue;
      }
      if (x > 0) {
        const to = at + stride - 4;
        pixels[to]! += (er * 3) / 16;
        pixels[to + 1]! += (eg * 3) / 16;
        pixels[to + 2]! += (eb * 3) / 16;
        pixels[to + 3]! += (ea * 3) / 16;
      }
      {
        const to = at + stride;
        pixels[to]! += (er * 5) / 16;
        pixels[to + 1]! += (eg * 5) / 16;
        pixels[to + 2]! += (eb * 5) / 16;
        pixels[to + 3]! += (ea * 5) / 16;
      }
      if (x + 1 < width) {
        const to = at + stride + 4;
        pixels[to]! += er / 16;
        pixels[to + 1]! += eg / 16;
        pixels[to + 2]! += eb / 16;
        pixels[to + 3]! += ea / 16;
      }
    }
  }
  return indices;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4
  );
  out.set(data, 8);
  view.setUint32(
    8 + data.length,
    Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0
  );
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 8-bit palette PNG encoder. An RGB PNG of a photo-like image is mostly
 * incompressible; the same image quantised to 256 dithered colours is roughly
 * three times smaller, which is what matters when the bytes are re-sent to a
 * terminal as a graphics escape sequence.
 */
export class IndexedPng {
  /** `rgba` is `width * height * 4` bytes, row-major, as photon lays it out. */
  public static encode(
    rgba: Uint8Array,
    width: number,
    height: number
  ): Uint8Array {
    if (rgba.length !== width * height * 4) {
      throw new Error(
        `IndexedPng: expected ${width * height * 4} RGBA bytes, got ${rgba.length}`
      );
    }
    const palette = buildPalette(rgba);
    const indices = dither(rgba, width, height, palette);
    const colors = palette.length / 4;

    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, width);
    ihdrView.setUint32(4, height);
    ihdr.set([8, 3, 0, 0, 0], 8);

    const plte = new Uint8Array(colors * 3);
    const trns = new Uint8Array(colors);
    let opaque = colors;
    for (let i = 0; i < colors; i++) {
      plte.set(palette.subarray(i * 4, i * 4 + 3), i * 3);
      trns[i] = palette[i * 4 + 3]!;
    }
    // tRNS entries default to 255, so trailing opaque ones can be dropped.
    while (opaque > 0 && trns[opaque - 1] === 255) {
      opaque--;
    }

    const raw = new Uint8Array(height * (width + 1));
    for (let y = 0; y < height; y++) {
      raw.set(
        indices.subarray(y * width, (y + 1) * width),
        y * (width + 1) + 1
      );
    }
    const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

    return concat([
      PNG_SIGNATURE,
      chunk("IHDR", ihdr),
      chunk("PLTE", plte),
      ...(opaque > 0 ? [chunk("tRNS", trns.subarray(0, opaque))] : []),
      chunk("IDAT", idat),
      chunk("IEND", new Uint8Array(0)),
    ]);
  }
}
