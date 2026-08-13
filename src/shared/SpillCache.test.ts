import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpillCache } from "./SpillCache";

let previousPimHomeDir: string | undefined;
let testPimHomeDir: string | undefined;

beforeAll(async () => {
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  testPimHomeDir = await mkdtemp(join(tmpdir(), "pim-spill-home-"));
  process.env.PIM_HOME_DIR = testPimHomeDir;
});

afterAll(async () => {
  if (previousPimHomeDir === undefined) {
    delete process.env.PIM_HOME_DIR;
  } else {
    process.env.PIM_HOME_DIR = previousPimHomeDir;
  }
  if (testPimHomeDir) {
    await rm(testPimHomeDir, { recursive: true, force: true });
  }
});

describe("SpillCache.write", () => {
  test("writes a prefixed UUIDv7 file with locked-down modes", async () => {
    const path = await SpillCache.write("fetch", "md", "# hello\nworld");
    expect(path).toBeTruthy();
    expect(path!.startsWith(join(SpillCache.dir(), "fetch-"))).toBe(true);
    expect(path!.endsWith(".md")).toBe(true);

    const dirMode = (await stat(SpillCache.dir())).mode & 0o777;
    const fileMode = (await stat(path!)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    expect(await Bun.file(path!).text()).toBe("# hello\nworld");
  });

  test("accepts binary payloads", async () => {
    const path = await SpillCache.write(
      "bash",
      "out",
      new Uint8Array([65, 66])
    );
    expect(path).toBeTruthy();
    expect(await Bun.file(path!).text()).toBe("AB");
  });
});

describe("SpillCache.cleanup", () => {
  test("deletes only expired spill files across prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pim-spill-cleanup-"));
    const now = Date.now();
    const oldBash = join(root, "bash-0192ce11-26d5-7dc3-9305-1426de888c5a.out");
    const oldFetch = join(
      root,
      "fetch-0192ce11-26d5-7dc3-9305-1426de888c5b.md"
    );
    const recent = join(root, "bash-0192ce11-26d5-7dc4-8894-bc88d506d6ee.err");
    const invalidName = join(root, "bash-not-a-uuid.out");
    const unrelated = join(root, "other-old.out");
    try {
      await writeFile(oldBash, "old");
      await writeFile(oldFetch, "old");
      await writeFile(recent, "recent");
      await writeFile(invalidName, "invalid");
      await writeFile(unrelated, "unrelated");
      const oldDate = new Date(now - SpillCache.TTL_MS - 1000);
      await utimes(oldBash, oldDate, oldDate);
      await utimes(oldFetch, oldDate, oldDate);
      await utimes(invalidName, oldDate, oldDate);
      await utimes(unrelated, oldDate, oldDate);

      await SpillCache.cleanup(root, now);

      expect(await Bun.file(oldBash).exists()).toBe(false);
      expect(await Bun.file(oldFetch).exists()).toBe(false);
      expect(await Bun.file(recent).exists()).toBe(true);
      expect(await Bun.file(invalidName).exists()).toBe(true);
      expect(await Bun.file(unrelated).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is a no-op when the cache dir is absent", async () => {
    await expect(
      SpillCache.cleanup(join(tmpdir(), "pim-spill-missing-dir"), Date.now())
    ).resolves.toBeUndefined();
  });

  test("evicts oldest spills beyond the total-size budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "pim-spill-budget-"));
    const now = Date.now();
    const oldest = join(root, "bash-0192ce11-26d5-7dc3-9305-1426de888c5a.out");
    const middle = join(root, "bash-0192ce11-26d5-7dc3-9305-1426de888c5b.out");
    const newest = join(root, "bash-0192ce11-26d5-7dc3-9305-1426de888c5c.out");
    try {
      // 3 files of 100 bytes each, all within TTL; budget of 250 bytes must
      // evict exactly the oldest one.
      await writeFile(oldest, "a".repeat(100));
      await writeFile(middle, "b".repeat(100));
      await writeFile(newest, "c".repeat(100));
      await utimes(oldest, new Date(now - 3000), new Date(now - 3000));
      await utimes(middle, new Date(now - 2000), new Date(now - 2000));
      await utimes(newest, new Date(now - 1000), new Date(now - 1000));

      await SpillCache.cleanup(root, now, 250);

      expect(await Bun.file(oldest).exists()).toBe(false);
      expect(await Bun.file(middle).exists()).toBe(true);
      expect(await Bun.file(newest).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves everything when under the total-size budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "pim-spill-under-"));
    const now = Date.now();
    const file = join(root, "bash-0192ce11-26d5-7dc3-9305-1426de888c5a.out");
    try {
      await writeFile(file, "a".repeat(100));
      await SpillCache.cleanup(root, now, 250);
      expect(await Bun.file(file).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
