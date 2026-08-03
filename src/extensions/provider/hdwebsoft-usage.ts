import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UsageBucket = {
  readonly name: string;
  readonly used_percent: number;
  readonly remaining_percent: number;
  readonly resets_at: string;
};

export type UsageData = {
  readonly generated_at: string;
  readonly usage: Record<string, readonly UsageBucket[]>;
};

export type UsageStyle =
  | "title"
  | "ctx"
  | "fam"
  | "muted"
  | "pct"
  | "dim"
  | "error";

export type UsageColorFn = (style: UsageStyle, text: string) => string;

const BUCKET_RANK: Record<string, number> = {
  session: 0,
  "5-hour": 1,
  weekly: 2,
  "7-day": 3,
  monthly: 4,
};
const UNKNOWN_RANK = 99;
const BAR_CELLS = 10;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const FETCH_TIMEOUT_MS = 15_000;

function bar(usedPercent: number): string {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round(usedPercent / 10)));
  return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

function relativeReset(resetsAt: string, nowMs: number): string {
  const ms = new Date(resetsAt).getTime() - nowMs;
  if (!Number.isFinite(ms)) {
    return "";
  }
  const totalMins = Math.round(ms / MINUTE_MS);
  if (totalMins < 1) {
    return "resets soon";
  }
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const mins = Math.round((ms % HOUR_MS) / MINUTE_MS);
  if (days > 0) {
    return `resets in ${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  }
  if (hours > 0) {
    return `resets in ${hours}h ${mins}m`;
  }
  return `resets in ${mins}m`;
}

export function renderUsageReport(
  data: UsageData,
  color: UsageColorFn,
  nowMs: number = Date.now()
): readonly string[] {
  const lines: string[] = [];
  for (const [family, buckets] of Object.entries(data.usage)) {
    if (buckets.length === 0) {
      continue;
    }
    lines.push(color("fam", family));
    const sorted = [...buckets].sort(
      (a, b) =>
        (BUCKET_RANK[a.name] ?? UNKNOWN_RANK) -
        (BUCKET_RANK[b.name] ?? UNKNOWN_RANK)
    );
    const labelWidth = Math.max(...sorted.map((b) => b.name.length));
    for (const bucket of sorted) {
      const used = Number(bucket.used_percent);
      const pct = `${Number.isFinite(used) ? Math.round(used) : 0}`.padStart(3);
      const reset = bucket.resets_at
        ? color("dim", relativeReset(bucket.resets_at, nowMs))
        : "";
      lines.push(
        color("muted", `  ${bucket.name.padEnd(labelWidth)} `) +
          color("pct", `${bar(used)} ${pct}%`) +
          (reset ? `  ${reset}` : "")
      );
    }
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function colorFor(ctx: ExtensionContext): UsageColorFn {
  if (!ctx.hasUI) {
    return (_style, text) => text;
  }
  const theme = ctx.ui.theme;
  return (style, text) => {
    switch (style) {
      case "title":
        return theme.bold(theme.fg("text", text));
      case "ctx":
        return theme.fg("muted", text);
      case "fam":
        return theme.fg("mdHeading", text);
      case "muted":
        return theme.fg("muted", text);
      case "pct":
        return theme.fg("mdCode", text);
      case "dim":
        return theme.fg("dim", text);
      case "error":
        return theme.fg("error", text);
    }
  };
}

function sessionCost(ctx: ExtensionContext): number {
  let cost = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += (entry.message as AssistantMessage).usage?.cost?.total ?? 0;
    }
  }
  return cost;
}

export function buildContextLines(
  ctx: ExtensionContext,
  color: UsageColorFn
): readonly string[] {
  const lines: string[] = [];
  const usage = ctx.getContextUsage();
  if (usage) {
    const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "—";
    const tokens = usage.tokens?.toLocaleString("en-US") ?? "—";
    const window = usage.contextWindow.toLocaleString("en-US");
    lines.push(color("ctx", `Context ${tokens} / ${window} (${pct})`));
  }
  lines.push(color("ctx", `Session cost $${sessionCost(ctx).toFixed(2)}`));
  return lines;
}

export async function fetchHdwebsoftUsage(
  root: string,
  apiKey: string
): Promise<UsageData> {
  const res = await fetch(`${root}/v1/usage`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as UsageData;
}
