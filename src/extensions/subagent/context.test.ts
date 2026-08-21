import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSubagentPrompt } from "./context";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "subagent-context-"));
}

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir();
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(dir, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  const proc = Bun.spawn(["git", "init", "-q"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  return dir;
}

function numbered(count: number): string {
  return `${Array.from({ length: count }, (_, i) => `line-${i + 1}`).join("\n")}\n`;
}

describe("buildSubagentPrompt — context_paths", () => {
  test("returns the prompt untouched with no paths and no citations", async () => {
    expect(await buildSubagentPrompt("do a thing", undefined, "/work")).toBe(
      "do a thing"
    );
    expect(await buildSubagentPrompt("do a thing", [], "/work")).toBe(
      "do a thing"
    );
  });

  test("inlines a whole file with line numbers", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "one\ntwo\nthree\n");

    const out = await buildSubagentPrompt("task", ["a.ts"], dir);

    expect(out).toStartWith("task\n\n");
    expect(out).toContain("## Provided context files");
    expect(out).toContain("### a.ts");
    expect(out).not.toContain("(lines");
    expect(out).toContain("1: one\n2: two\n3: three");
  });

  test("slices a 1-based inclusive line range and shows it in the heading", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");

    const out = await buildSubagentPrompt("task", ["a.ts:2-3"], dir);

    expect(out).toContain("### a.ts (lines 2-3)");
    expect(out).toContain("2: two\n3: three");
    expect(out).not.toContain("1: one");
    expect(out).not.toContain("4: four");
  });

  test("a single-line range reads one line and clamps out-of-bounds ends", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "one\ntwo\n");

    const single = await buildSubagentPrompt("task", ["a.ts:2"], dir);
    expect(single).toContain("### a.ts (lines 2-2)");
    expect(single).toContain("2: two");

    const clamped = await buildSubagentPrompt("task", ["a.ts:1-99"], dir);
    expect(clamped).toContain("1: one\n2: two");
  });

  test("resolves absolute paths regardless of cwd", async () => {
    const dir = await makeTempDir();
    const absolute = join(dir, "abs.ts");
    await writeFile(absolute, "abs\n");

    const out = await buildSubagentPrompt(
      "task",
      [absolute],
      "/somewhere/else"
    );

    expect(out).toContain("1: abs");
  });

  test("throws Path not found for a missing file", async () => {
    const dir = await makeTempDir();

    const result = buildSubagentPrompt("task", ["missing.ts"], dir);

    await expect(result).rejects.toThrow("Path not found");
  });

  test("throws for a directory entry", async () => {
    const dir = await makeTempDir();

    const result = buildSubagentPrompt("task", ["."], dir);

    await expect(result).rejects.toThrow("is a directory");
  });

  test("throws for an out-of-bounds range", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "one\n");

    const result = buildSubagentPrompt("task", ["a.ts:5-9"], dir);

    await expect(result).rejects.toThrow("range out of bounds");
    await expect(result).rejects.toThrow("1 lines");
  });

  test("rejects a file exceeding the per-file cap and names it", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "big.ts"), numbered(50));

    const result = buildSubagentPrompt("task", ["big.ts"], dir, 10_000, 200);

    await expect(result).rejects.toThrow("context_paths too large");
    await expect(result).rejects.toThrow("big.ts");
    await expect(result).rejects.toThrow("per-file cap");
  });

  test("a narrow range on a big file passes the per-file cap", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "big.ts"), numbered(50));

    const out = await buildSubagentPrompt(
      "task",
      ["big.ts:10-12"],
      dir,
      10_000,
      200
    );

    expect(out).toContain("### big.ts (lines 10-12)");
    expect(out).toContain("10: line-10\n11: line-11\n12: line-12");
  });

  test("rejects a non-text file passed explicitly", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, "icon.png"),
      Buffer.from([0x89, 0x50, 0x00, 0x1a])
    );

    const result = buildSubagentPrompt("task", ["icon.png"], dir);

    await expect(result).rejects.toThrow("is not a text file");
  });

  test("rejects when the total exceeds the overall cap", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), numbered(20));
    await writeFile(join(dir, "b.ts"), numbered(20));

    const result = buildSubagentPrompt("task", ["a.ts", "b.ts"], dir, 300, 250);

    await expect(result).rejects.toThrow("total");
    await expect(result).rejects.toThrow("nothing was sent to the subagent");
  });
});

describe("buildSubagentPrompt — cited files", () => {
  test("inlines a file the brief cites but never passed", async () => {
    const dir = await makeRepo({ "src/a.ts": "one\ntwo\nthree\n" });

    const out = await buildSubagentPrompt(
      "The bug is at `src/a.ts:2`.",
      undefined,
      dir
    );

    expect(out).toContain("### src/a.ts");
    expect(out).toContain("1: one\n2: two\n3: three");
  });

  test("resolves a shortened citation by unique path suffix", async () => {
    const dir = await makeRepo({
      "src/pkg/kernel/runtime/pipeline.py": "a\nb\nc\n",
    });

    const out = await buildSubagentPrompt(
      "See `kernel/runtime/pipeline.py:2-3` for the conflict path.",
      undefined,
      dir
    );

    expect(out).toContain("### src/pkg/kernel/runtime/pipeline.py");
    expect(out).toContain("1: a\n2: b\n3: c");
  });

  test("skips a citation whose suffix matches more than one file", async () => {
    const dir = await makeRepo({
      "src/kernel/runtime.py": "kernel\n",
      "src/adapters/runtime.py": "adapters\n",
    });

    const out = await buildSubagentPrompt(
      "Look at runtime.py:1.",
      undefined,
      dir
    );

    expect(out).toBe("Look at runtime.py:1.");
  });

  test("does not re-inline a file already passed via context_paths", async () => {
    const dir = await makeRepo({ "src/a.ts": "one\ntwo\n" });

    const out = await buildSubagentPrompt(
      "The bug is at `src/a.ts:2`.",
      ["src/a.ts"],
      dir
    );

    expect(out.match(/### src\/a\.ts/gu)).toHaveLength(1);
  });

  test("windows a large file around the citation instead of inlining it whole", async () => {
    const dir = await makeRepo({ "src/big.ts": numbered(1000) });

    const out = await buildSubagentPrompt(
      "Fails at src/big.ts:500.",
      undefined,
      dir
    );

    expect(out).toContain("### src/big.ts (lines 460-540)");
    expect(out).toContain("500: line-500");
    expect(out).not.toContain("1: line-1\n");
    expect(out).not.toContain("600: line-600");
  });

  test("merges nearby citations of the same file into one window", async () => {
    const dir = await makeRepo({ "src/big.ts": numbered(1000) });

    const out = await buildSubagentPrompt(
      "Claim at src/big.ts:500 and again at src/big.ts:520.",
      undefined,
      dir
    );

    expect(out.match(/### src\/big\.ts/gu)).toHaveLength(1);
    expect(out).toContain("### src/big.ts (lines 460-560)");
  });

  test("inlines a file the brief names without a line number", async () => {
    const dir = await makeRepo({
      "docs/decisions/0006-idempotency.md": "contract\nrules\n",
    });

    const out = await buildSubagentPrompt(
      "Check which is authoritative (docs/decisions/0006-idempotency.md).",
      undefined,
      dir
    );

    expect(out).toContain("### docs/decisions/0006-idempotency.md");
    expect(out).toContain("1: contract\n2: rules");
  });

  test("line-cited files claim the budget before bare mentions", async () => {
    const dir = await makeRepo({
      "src/bare.ts": numbered(20),
      "src/cited.ts": numbered(20),
    });

    const out = await buildSubagentPrompt(
      "Read src/bare.ts, then look at src/cited.ts:5.",
      undefined,
      dir,
      300,
      300
    );

    expect(out).toContain("### src/cited.ts");
    expect(out).not.toContain("### src/bare.ts");
    expect(out).toContain("Not inlined");
    expect(out).toContain("src/bare.ts");
  });

  test("ignores unresolvable paths and non-path colon numbers", async () => {
    const dir = await makeRepo({ "src/a.ts": "one\n" });

    const out = await buildSubagentPrompt(
      "Ran at 12:30, see gone.ts:4 and https://example.com:8080.",
      undefined,
      dir
    );

    expect(out).toBe(
      "Ran at 12:30, see gone.ts:4 and https://example.com:8080."
    );
  });

  test("skips a cited binary file instead of inlining mojibake", async () => {
    const dir = await makeRepo({});
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(
      join(dir, "assets/icon.png"),
      Buffer.from([0x89, 0x50, 0x00, 0x1a])
    );

    const out = await buildSubagentPrompt(
      "Logo lives at assets/icon.png.",
      undefined,
      dir
    );

    expect(out).toBe("Logo lives at assets/icon.png.");
  });

  test("resolves a citation without a git repo to fall back on", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "one\ntwo\n");

    const out = await buildSubagentPrompt("Bug at src/a.ts:2.", undefined, dir);

    expect(out).toContain("### src/a.ts");
    expect(out).toContain("2: two");
  });

  test("a file cited both bare and with a line is windowed, not inlined whole", async () => {
    const dir = await makeRepo({ "src/big.ts": numbered(1000) });

    const out = await buildSubagentPrompt(
      "Start from src/big.ts, the fault is at src/big.ts:500.",
      undefined,
      dir
    );

    expect(out).toContain("### src/big.ts (lines 460-540)");
    expect(out).not.toContain("999: line-999");
  });

  test("ignores a citation that names a directory", async () => {
    const dir = await makeRepo({ "src/pkg.ts/inner.ts": "inner\n" });

    const out = await buildSubagentPrompt(
      "Look in src/pkg.ts.",
      undefined,
      dir
    );

    expect(out).toBe("Look in src/pkg.ts.");
  });

  test("names cited files it could not fit instead of dropping them silently", async () => {
    const dir = await makeRepo({ "src/big.ts": numbered(1000) });

    const out = await buildSubagentPrompt(
      "Fails at src/big.ts:500.",
      undefined,
      dir,
      200,
      200
    );

    expect(out).toContain("Not inlined");
    expect(out).toContain("src/big.ts");
    expect(out).not.toContain("500: line-500");
  });
});
