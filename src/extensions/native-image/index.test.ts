import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCapturedImage } from "./index";

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
