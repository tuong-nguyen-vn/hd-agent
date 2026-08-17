import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextBlock } from "./context";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "subagent-context-"));
}

describe("buildContextBlock", () => {
  test("returns empty string for missing or empty context_paths", async () => {
    expect(await buildContextBlock(undefined, "/work")).toBe("");
    expect(await buildContextBlock([], "/work")).toBe("");
  });

  test("inlines a whole file with line numbers", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "one\ntwo\nthree\n");

    const block = await buildContextBlock(["a.ts"], dir);

    expect(block).toContain("## Provided context files");
    expect(block).toContain("### a.ts");
    expect(block).not.toContain("(lines");
    expect(block).toContain("1: one\n2: two\n3: three");
  });

  test("slices a 1-based inclusive line range and shows it in the heading", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");

    const block = await buildContextBlock(["a.ts:2-3"], dir);

    expect(block).toContain("### a.ts (lines 2-3)");
    expect(block).toContain("2: two\n3: three");
    expect(block).not.toContain("1: one");
    expect(block).not.toContain("4: four");
  });

  test("a single-line range reads one line and clamps out-of-bounds ends", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "one\ntwo\n");

    const single = await buildContextBlock(["a.ts:2"], dir);
    expect(single).toContain("### a.ts (lines 2-2)");
    expect(single).toContain("2: two");

    const clamped = await buildContextBlock(["a.ts:1-99"], dir);
    expect(clamped).toContain("1: one\n2: two");
  });

  test("resolves absolute paths regardless of cwd", async () => {
    const dir = await makeTempDir();
    const absolute = join(dir, "abs.ts");
    await writeFile(absolute, "abs\n");

    const block = await buildContextBlock([absolute], "/somewhere/else");

    expect(block).toContain("1: abs");
  });

  test("throws Path not found for a missing file", async () => {
    const dir = await makeTempDir();

    const result = buildContextBlock(["missing.ts"], dir);

    await expect(result).rejects.toThrow("Path not found");
  });

  test("throws for a directory entry", async () => {
    const dir = await makeTempDir();

    const result = buildContextBlock(["."], dir);

    await expect(result).rejects.toThrow("is a directory");
  });

  test("throws for an out-of-bounds range", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "one\n");

    const result = buildContextBlock(["a.ts:5-9"], dir);

    await expect(result).rejects.toThrow("range out of bounds");
    await expect(result).rejects.toThrow("1 lines");
  });

  test("rejects a file exceeding the per-file cap and names it", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(dir, "big.ts"), `${lines.join("\n")}\n`);

    const result = buildContextBlock(["big.ts"], dir, 10_000, 200);

    await expect(result).rejects.toThrow("context_paths too large");
    await expect(result).rejects.toThrow("big.ts");
    await expect(result).rejects.toThrow("per-file cap");
  });

  test("a narrow range on a big file passes the per-file cap", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(dir, "big.ts"), `${lines.join("\n")}\n`);

    const block = await buildContextBlock(["big.ts:10-12"], dir, 10_000, 200);

    expect(block).toContain("### big.ts (lines 10-12)");
    expect(block).toContain("10: line-10\n11: line-11\n12: line-12");
  });

  test("rejects when the total exceeds the overall cap", async () => {
    const dir = await makeTempDir();
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(dir, "a.ts"), `${lines.join("\n")}\n`);
    await writeFile(join(dir, "b.ts"), `${lines.join("\n")}\n`);

    const result = buildContextBlock(["a.ts", "b.ts"], dir, 300, 250);

    await expect(result).rejects.toThrow("total");
    await expect(result).rejects.toThrow("nothing was sent to the subagent");
  });
});
