import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  mintOracleGateToken,
  resolveSubagentOnlyModels,
  SUBAGENT_ONLY_MODELS,
  withOracleGateHeaders,
} from "./oracle-gate";
import { resolveSubagentModelCandidates } from "./subagent";

const WINDOW_MS = 900 * 1000;

describe("mintOracleGateToken", () => {
  test("is deterministic within a window and rotates across windows", () => {
    const now = 1_700_000_123_000;
    expect(mintOracleGateToken(now)).toBe(mintOracleGateToken(now + 1000));
    expect(mintOracleGateToken(now)).not.toBe(
      mintOracleGateToken(now + WINDOW_MS)
    );
    expect(mintOracleGateToken(now)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveSubagentOnlyModels", () => {
  test("matches by bare id and provider/id, case-insensitively", () => {
    expect(resolveSubagentOnlyModels("GPT-5.6-SOL")).toHaveLength(1);
    expect(
      resolveSubagentOnlyModels("hdwebsoft-proxy/gpt-5.6-sol")
    ).toHaveLength(1);
    expect(resolveSubagentOnlyModels("glm-5-3")).toHaveLength(0);
  });
});

describe("withOracleGateHeaders", () => {
  test("attaches the gate token header to the gated model only", () => {
    const gated = SUBAGENT_ONLY_MODELS[0]!;
    const now = 1_700_000_123_000;

    const withHeaders = withOracleGateHeaders(gated, now);
    expect(withHeaders?.headers?.["x-hd-oracle"]).toBe(
      mintOracleGateToken(now)
    );
    // The shared model spec must stay untouched.
    expect(gated.headers).toBeUndefined();

    const other = { provider: "hdwebsoft-proxy", id: "glm-5-2" } as never;
    expect(withOracleGateHeaders(other, now)).toBe(other);
    expect(withOracleGateHeaders(undefined, now)).toBeUndefined();
  });
});

describe("subagent-only model resolution precedence", () => {
  test("gpt-5.6-sol prefers the hdwebsoft gate but keeps same-id registry entries as fallbacks", () => {
    const personalProxySol = {
      provider: "tuongnguyen-proxy",
      id: "gpt-5.6-sol",
    } as never;
    const ctx = {
      model: { provider: "tuongnguyen-proxy", id: "parent-model" } as never,
      modelRegistry: {
        getAll: () => [personalProxySol],
        hasConfiguredAuth: () => true,
      },
    } as unknown as ExtensionContext;

    const candidates = resolveSubagentModelCandidates(ctx, {
      name: "Oracle",
      description: "Oracle",
      tools: undefined,
      model: "gpt-5.6-sol,glm-5-2",
      systemPrompt: "",
      source: "bundled",
    });

    expect(candidates[0]).toBe(SUBAGENT_ONLY_MODELS[0]);
    expect(candidates[1]).toBe(personalProxySol);
  });
});
