import { closeSync, writeSync } from "node:fs";
import { Lines } from "../../shared/Lines";
import { SpillCache } from "../../shared/SpillCache";
import {
  type CapturedStream,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

export function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const MEMORY_CAP_BYTES = STREAM_HEAD_BYTES + STREAM_TAIL_BYTES;

type SpillTarget = {
  readonly prefix: string;
  readonly ext: string;
};

/**
 * Captures a process stream with bounded memory. Up to
 * STREAM_HEAD_BYTES + STREAM_TAIL_BYTES is retained in RAM; beyond that the
 * full stream is written incrementally to a spill file (when a spill target
 * is configured) and memory keeps only the head plus a rolling tail, so a
 * high-output command cannot grow the process heap without limit.
 */
export class StreamCapture {
  // Under the cap: every chunk, in order. Over the cap: a rolling tail
  // trimmed to at least STREAM_TAIL_BYTES.
  private chunks: Uint8Array[] = [];
  private chunkBytes = 0;
  // Set once the cap is crossed; holds at least STREAM_HEAD_BYTES.
  private headChunks: Uint8Array[] | null = null;
  private headBytes = 0;
  private totalBytesAccum = 0;
  private spillFd: number | null = null;
  private spillPath: string | null = null;
  private spillFailed = false;

  constructor(private readonly spill?: SpillTarget) {}

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) {
      return;
    }
    this.totalBytesAccum += chunk.byteLength;

    if (this.spillFd !== null) {
      this.writeToSpill(chunk);
    } else if (
      this.headChunks === null &&
      this.totalBytesAccum > MEMORY_CAP_BYTES
    ) {
      this.crossCap(chunk);
    }

    if (this.headChunks === null) {
      this.chunks.push(chunk);
      this.chunkBytes += chunk.byteLength;
      return;
    }

    this.chunks.push(chunk);
    this.chunkBytes += chunk.byteLength;
    this.trimTail();
  }

  get totalBytes(): number {
    return this.totalBytesAccum;
  }

  get truncated(): boolean {
    return this.totalBytesAccum > STREAM_HEAD_BYTES + STREAM_TAIL_BYTES;
  }

  /**
   * Closes the spill file (if one was opened) and returns its path.
   * Call once after the stream is fully drained.
   */
  finishSpill(): string | null {
    if (this.spillFd !== null) {
      try {
        closeSync(this.spillFd);
      } catch {
        this.spillPath = null;
      }
      this.spillFd = null;
    }
    return this.spillPath;
  }

  snapshot(): CapturedStream {
    if (this.totalBytesAccum === 0) {
      return {
        text: "",
        totalBytes: 0,
        truncated: false,
        path: null,
        nextStart: null,
      };
    }
    const dec = new TextDecoder();
    if (!this.truncated) {
      return {
        text: dec.decode(concat(this.chunks, this.chunkBytes)),
        totalBytes: this.totalBytesAccum,
        truncated: false,
        path: null,
        nextStart: null,
      };
    }
    const headText = dec.decode(this.headSlice());
    const tailText = dec.decode(this.tailSlice());
    const middle = this.totalBytesAccum - STREAM_HEAD_BYTES - STREAM_TAIL_BYTES;
    return {
      text: `${headText}\n... ${middle} bytes truncated ...\n${tailText}`,
      totalBytes: this.totalBytesAccum,
      truncated: true,
      path: null,
      nextStart: Lines.continuationLine(headText),
    };
  }

  // The push that crosses the memory cap: open the spill file, back-fill
  // everything received so far, and split retained memory into a fixed head
  // and a rolling tail.
  private crossCap(current: Uint8Array): void {
    if (this.spill && !this.spillFailed) {
      const opened = SpillCache.openSync(this.spill.prefix, this.spill.ext);
      if (opened) {
        this.spillFd = opened.fd;
        this.spillPath = opened.path;
        for (const prior of this.chunks) {
          this.writeToSpill(prior);
        }
        this.writeToSpill(current);
      } else {
        this.spillFailed = true;
      }
    }

    this.headChunks = [];
    this.headBytes = 0;
    for (const prior of this.chunks) {
      if (this.headBytes >= STREAM_HEAD_BYTES) {
        break;
      }
      this.headChunks.push(prior);
      this.headBytes += prior.byteLength;
    }
    if (this.headBytes < STREAM_HEAD_BYTES) {
      this.headChunks.push(current);
      this.headBytes += current.byteLength;
    }
    this.trimTail();
  }

  private trimTail(): void {
    while (
      this.chunks.length > 1 &&
      this.chunkBytes - (this.chunks[0]?.byteLength ?? 0) >= STREAM_TAIL_BYTES
    ) {
      const dropped = this.chunks.shift();
      this.chunkBytes -= dropped?.byteLength ?? 0;
    }
  }

  private writeToSpill(chunk: Uint8Array): void {
    if (this.spillFd === null) {
      return;
    }
    try {
      writeSync(this.spillFd, chunk);
    } catch {
      this.spillFailed = true;
      try {
        closeSync(this.spillFd);
      } catch {}
      this.spillFd = null;
      this.spillPath = null;
    }
  }

  private headSlice(): Uint8Array {
    const source = this.headChunks ?? this.chunks;
    const bytes = this.headChunks ? this.headBytes : this.chunkBytes;
    return concat(source, bytes).subarray(0, STREAM_HEAD_BYTES);
  }

  private tailSlice(): Uint8Array {
    const all = concat(this.chunks, this.chunkBytes);
    return all.subarray(Math.max(0, all.byteLength - STREAM_TAIL_BYTES));
  }
}
