import type { Model } from "@earendil-works/pi-ai";
import { HDWEBSOFT_PROXY_ROOT } from "../provider/hdwebsoft-proxy";

// gpt-5.6-sol is blocked on the hdwebsoft gateway for regular use. The
// gateway's oracle-gate plugin only routes it upstream when the request both
// carries a valid time-windowed HMAC token in this header and declares
// exactly the Oracle tool set. The models below are therefore deliberately
// kept out of the provider registry (and the model picker): they resolve for
// subagents only, via resolveSubagentOnlyModels().
const ORACLE_GATE_HEADER = "x-hd-oracle";
const ORACLE_GATE_WINDOW_SECONDS = 900;
// Shared with the gateway plugin config. This is a gate, not a secret: anyone
// with repo access can read it, which is accepted — the gateway still pins
// requests to the Oracle tool fingerprint and logs every use per API key.
const ORACLE_GATE_PEPPER =
  "80d90d0b49bacbb04df64a30c660b09b2e6b0f25f02e1bfd2bef6e1e61622abf";

const GATED_SOL_MODEL: Model<"openai-completions"> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "hdwebsoft-proxy",
  api: "openai-completions",
  baseUrl: `${HDWEBSOFT_PROXY_ROOT}/v1`,
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  contextWindow: 500000,
  maxTokens: 128000,
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",
  },
};

export const SUBAGENT_ONLY_MODELS: readonly Model<any>[] = [GATED_SOL_MODEL];

// Resolves a subagent "model" reference against the subagent-only models.
// Takes precedence over the shared model registry so a same-named registry
// entry (e.g. from another provider) cannot shadow the gated route.
export function resolveSubagentOnlyModels(
  reference: string
): readonly Model<any>[] {
  const normalized = reference.trim().toLowerCase();
  return SUBAGENT_ONLY_MODELS.filter(
    (model) =>
      model.id.toLowerCase() === normalized ||
      `${model.provider}/${model.id}`.toLowerCase() === normalized
  );
}

export function mintOracleGateToken(nowMs: number = Date.now()): string {
  const window = Math.floor(nowMs / 1000 / ORACLE_GATE_WINDOW_SECONDS);
  const hasher = new Bun.CryptoHasher("sha256", ORACLE_GATE_PEPPER);
  hasher.update(String(window));
  return hasher.digest("hex");
}

// Attaches the gate token header when (and only when) the session is about
// to run on a subagent-only model. The token is minted per session; the
// gateway accepts the current and previous window, so sessions stay valid
// for at least ORACLE_GATE_WINDOW_SECONDS after spawn.
export function withOracleGateHeaders(
  model: Model<any> | undefined,
  nowMs: number = Date.now()
): Model<any> | undefined {
  if (
    !model ||
    !SUBAGENT_ONLY_MODELS.some(
      (gated) => gated.provider === model.provider && gated.id === model.id
    )
  ) {
    return model;
  }
  return {
    ...model,
    headers: {
      ...model.headers,
      [ORACLE_GATE_HEADER]: mintOracleGateToken(nowMs),
    },
  };
}
