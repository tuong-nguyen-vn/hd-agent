import { existsSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { fetchOpencodeFreeModels } from "./opencode-free";

const CACHE_FILE = join(
  homedir(),
  ".pi",
  "agent",
  ".cache",
  "opencode-free-meta.json"
);

describe("opencode-free", () => {
  it("fetches live free models from Zen + models.dev", async () => {
    const models = await fetchOpencodeFreeModels("https://proxy.example.com");
    expect(models.length).toBeGreaterThan(0);

    // All must be free (big-pickle or *-free)
    for (const m of models) {
      expect(m.id === "big-pickle" || m.id.endsWith("-free")).toBe(true);
    }

    // All point at the proxy /v1 with cost 0
    const sample = models[0]!;
    expect(sample.baseUrl).toBe("https://proxy.example.com/v1");
    expect(sample.api).toBe("openai-completions");
    expect(sample.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(sample.reasoning).toBe(true);
    expect(sample.input).toEqual(["text"]);
  });

  it("pins thinking to high only, everything else null", async () => {
    const models = await fetchOpencodeFreeModels("https://proxy.example.com");
    const map = models[0]!.thinkingLevelMap!;
    expect(map).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("uses models.dev metadata when available (ctx/maxTokens)", async () => {
    const models = await fetchOpencodeFreeModels("https://proxy.example.com");
    // deepseek-v4-flash-free is a known free model with ctx=200000, out=128000
    const ds = models.find((m) => m.id === "deepseek-v4-flash-free");
    expect(ds).toBeDefined();
    expect(ds!.contextWindow).toBe(200000);
    expect(ds!.maxTokens).toBe(128000);
    expect(ds!.name).toBeTruthy();
  });

  it("caches models.dev metadata to disk", async () => {
    // Clean slate
    rmSync(CACHE_FILE, { force: true });
    expect(existsSync(CACHE_FILE)).toBe(false);

    // First call populates cache
    await fetchOpencodeFreeModels("https://proxy.example.com");
    expect(existsSync(CACHE_FILE)).toBe(true);

    // Cache file has expected shape
    const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    expect(cached.fetchedAt).toBeGreaterThan(0);
    expect(typeof cached.models).toBe("object");
    expect(Object.keys(cached.models).length).toBeGreaterThan(0);
  });

  it("strips 'Free' and marketing suffixes from display names", async () => {
    const models = await fetchOpencodeFreeModels("https://proxy.example.com");
    for (const m of models) {
      // No "free" anywhere (case-insensitive) in the display name
      expect(m.name.toLowerCase()).not.toContain("free");
      // No trailing parenthetical like "(New)"
      expect(m.name).not.toMatch(/\([^)]*\)/);
    }
    // Spot-check a known rename
    const ds = models.find((m) => m.id === "deepseek-v4-flash-free");
    expect(ds!.name).toBe("DeepSeek V4 Flash");
  });

  it("returns [] when Zen API is unreachable", async () => {
    // Monkey-patch global fetch to simulate network failure for the Zen URL.
    const original = globalThis.fetch;
    globalThis.fetch = ((input: any) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("opencode.ai")) {
        return Promise.reject(new Error("network down"));
      }
      return original(input);
    }) as any;

    try {
      const models = await fetchOpencodeFreeModels("https://proxy.example.com");
      expect(models).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns empty meta (not throw) when models.dev is unreachable", async () => {
    // Zen works, models.dev fails → should still return models with defaults.
    const original = globalThis.fetch;
    let modelsDevCalled = false;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("models.dev")) {
        modelsDevCalled = true;
        throw new Error("models.dev down");
      }
      return original(input as any);
    }) as any;

    // Clear cache so models.dev is actually attempted
    rmSync(CACHE_FILE, { force: true });

    try {
      const models = await fetchOpencodeFreeModels("https://proxy.example.com");
      expect(modelsDevCalled).toBe(true);
      // Still got models from Zen, with fallback metadata
      expect(models.length).toBeGreaterThan(0);
      // All fall back to 200K / 32K since models.dev is unreachable
      for (const m of models) {
        expect(m.contextWindow).toBe(200000);
        expect(m.maxTokens).toBe(32000);
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
