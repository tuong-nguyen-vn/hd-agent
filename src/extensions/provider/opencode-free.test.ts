import { describe, expect, it } from "bun:test";
import { getOpencodeFreeModels } from "./opencode-free";

describe("opencode-free", () => {
  it("returns a static free-model list without network", () => {
    const models = getOpencodeFreeModels();
    expect(models.length).toBe(2);

    const ids = models.map((m) => m.id);
    expect(ids).toContain("deepseek-v4-flash-free");
    expect(ids).toContain("mimo-v2.5-free");
  });

  it("all models point at OpenCode Zen with cost 0", () => {
    for (const m of getOpencodeFreeModels()) {
      expect(m.baseUrl).toBe("https://opencode.ai/zen/v1");
      expect(m.api).toBe("openai-completions");
      expect(m.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(m.reasoning).toBe(true);
      expect(m.input).toEqual(["text"]);
    }
  });

  it("pins thinking to high only, everything else null", () => {
    for (const m of getOpencodeFreeModels()) {
      expect(m.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: null,
      });
    }
  });

  it("has sensible context window and max tokens defaults", () => {
    for (const m of getOpencodeFreeModels()) {
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("strips 'Free' from display names", () => {
    for (const m of getOpencodeFreeModels()) {
      expect(m.name.toLowerCase()).not.toContain("free");
    }
  });

  it("sets compat flags for OpenAI completions API", () => {
    for (const m of getOpencodeFreeModels()) {
      expect(m.compat).toEqual({
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      });
    }
  });
});
