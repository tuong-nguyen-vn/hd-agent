import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachImagePaths, findImagePaths } from "./attach-images";

const dir = mkdtempSync(join(tmpdir(), "attach-images-"));
const png = join(dir, "pi-clipboard-1.png");
const spaced = join(dir, "Screen Shot.jpg");
await Bun.write(png, new Uint8Array([1, 2, 3]));
await Bun.write(spaced, new Uint8Array([4, 5, 6]));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findImagePaths", () => {
  test("finds a pasted clipboard path followed by prose", () => {
    expect(findImagePaths("/tmp/pi-clipboard-a.png không hiểu")).toEqual([
      "/tmp/pi-clipboard-a.png",
    ]);
  });

  test("handles quoted, escaped, ~ and punctuated paths", () => {
    expect(
      findImagePaths(
        `see '/a/b c.png' and /d/e\\ f.jpg, ~/g.webp) plus "/h.gif".`
      )
    ).toEqual(["/a/b c.png", "/d/e f.jpg", "~/g.webp", "/h.gif"]);
  });

  test("ignores relative paths, non-images and slashes inside words", () => {
    expect(
      findImagePaths("fix src/logo.png and /tmp/notes.txt and/or x/y.png")
    ).toEqual([]);
  });

  test("dedupes repeated paths", () => {
    expect(findImagePaths("/a.png /a.png")).toEqual(["/a.png"]);
  });
});

describe("attachImagePaths", () => {
  test("attaches existing images and notes them in the text", async () => {
    const escaped = spaced.replace(/ /g, "\\ ");
    const result = await attachImagePaths(
      `${png} and ${escaped} and /missing/x.png`,
      dir
    );
    expect(result.images).toEqual([
      { type: "image", data: "AQID", mimeType: "image/png" },
      { type: "image", data: "BAUG", mimeType: "image/jpeg" },
    ]);
    expect(result.text).toBe(
      `${png} and ${escaped} and /missing/x.png\n\n[Image attached: ${png}]\n[Image attached: ${spaced}]`
    );
  });

  test("leaves text untouched when nothing is attached", async () => {
    const result = await attachImagePaths("no images here", dir);
    expect(result).toEqual({ text: "no images here", images: [] });
  });
});
