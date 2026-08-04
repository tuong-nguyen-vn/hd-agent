import { describe, expect, test } from "bun:test";
import { renderUsageReport, type UsageData } from "./hdwebsoft-usage";

// Real response shape from GET /v1/usage (2026-08-03).
const FIXTURE: UsageData = {
  generated_at: "2026-08-03T16:48:12.077056125Z",
  usage: {
    claude: [
      {
        name: "5-hour",
        used_percent: 11,
        remaining_percent: 89,
        resets_at: "",
        resets_at_max: "2026-08-03T21:20:00Z",
      },
      {
        name: "7-day",
        used_percent: 64,
        remaining_percent: 36,
        resets_at: "2026-08-04T10:00:00Z",
        resets_at_max: "2026-08-09T19:59:59Z",
      },
    ],
    deepseek: [
      {
        name: "monthly",
        used_percent: 6,
        remaining_percent: 94,
        resets_at: "2026-09-02T06:27:36Z",
        resets_at_max: "2026-09-02T06:27:36Z",
      },
      {
        name: "session",
        used_percent: 14,
        remaining_percent: 86,
        resets_at: "2026-08-03T17:21:17Z",
        resets_at_max: "2026-08-03T17:21:17Z",
      },
      {
        name: "weekly",
        used_percent: 7,
        remaining_percent: 93,
        resets_at: "2026-08-09T23:59:12Z",
        resets_at_max: "2026-08-09T23:59:12Z",
      },
    ],
    gemini: [
      {
        name: "5-hour",
        used_percent: 1,
        remaining_percent: 99,
        resets_at: "2026-08-03T17:28:12Z",
        resets_at_max: "2026-08-03T21:10:21Z",
      },
      {
        name: "weekly",
        used_percent: 33,
        remaining_percent: 67,
        resets_at: "2026-08-04T23:09:49Z",
        resets_at_max: "2026-08-07T10:35:58Z",
      },
    ],
  },
};

const identity: (style: string, text: string) => string = (_style, text) =>
  text;

function render(data: UsageData, now = Date.parse("2026-08-03T16:00:00Z")) {
  return renderUsageReport(data, identity, now);
}

describe("renderUsageReport", () => {
  test("sorts deepseek buckets session → weekly → monthly", () => {
    const lines = render(FIXTURE);
    const start = lines.indexOf("deepseek");
    const end = lines.indexOf("gemini", start + 1);
    const section = lines.slice(start + 1, end === -1 ? undefined : end);
    const rows = section.filter((l) => l.startsWith("  "));
    expect(rows.map((r) => r.trim().split(/\s/)[0])).toEqual([
      "session",
      "weekly",
      "monthly",
    ]);
  });

  test("sorts claude 5-hour → 7-day and gemini 5-hour → weekly", () => {
    const lines = render(FIXTURE);
    const claudeStart = lines.indexOf("claude");
    const geminiStart = lines.indexOf("gemini");
    expect(lines[claudeStart + 1]).toContain("5-hour");
    expect(lines[claudeStart + 2]).toContain("7-day");
    expect(lines[geminiStart + 1]).toContain("5-hour");
    expect(lines[geminiStart + 2]).toContain("weekly");
  });

  test("renders 10-cell bars", () => {
    const lines = render(FIXTURE);
    const line = lines.find((l) => l.includes("64%"))!;
    expect(line.match(/[█░]{10}/)![0]).toBe("██████░░░░");
    const zero = render({
      generated_at: "2026-08-03T16:00:00Z",
      usage: {
        gemini: [
          {
            name: "5-hour",
            used_percent: 0,
            remaining_percent: 100,
            resets_at: "2026-08-03T17:28:12Z",
            resets_at_max: "2026-08-03T21:10:21Z",
          },
        ],
      },
    }).find((l) => l.includes("0%"))!;
    expect(zero.match(/[█░]{10}/)![0]).toBe("░░░░░░░░░░");
  });

  test("renders recovery window when resets_at and resets_at_max differ", () => {
    const lines = render(FIXTURE);
    const weekly = lines.find(
      (l) => l.startsWith("  weekly") && l.includes("33%")
    )!;
    expect(weekly).toContain("resets partially in 1d 7h → 3d 18h");
  });

  test("falls back to resets_at_max when resets_at is empty", () => {
    const lines = render(FIXTURE);
    const fiveHour = lines.find((l) => l.includes("11%"))!;
    expect(fiveHour).toContain("resets in 5h 20m");
  });

  test("renders single reset when both ends are equal", () => {
    const lines = render(FIXTURE);
    const session = lines.find((l) => l.startsWith("  session"))!;
    expect(session).toContain("resets in 1h 21m");
    expect(session).not.toContain("→");
  });

  test("skips families the API did not return", () => {
    const lines = render({
      generated_at: "2026-08-03T16:48:12Z",
      usage: {
        claude: FIXTURE.usage.claude!,
      },
    });
    expect(lines.join("\n")).not.toContain("gemini");
    expect(lines.join("\n")).not.toContain("deepseek");
  });

  test("keeps unknown bucket names after known ones", () => {
    const lines = render({
      generated_at: "2026-08-03T16:00:00Z",
      usage: {
        deepseek: [
          {
            name: "mystery",
            used_percent: 1,
            remaining_percent: 99,
            resets_at: "2026-08-04T16:00:00Z",
          },
          {
            name: "session",
            used_percent: 9,
            remaining_percent: 91,
            resets_at: "2026-08-03T17:21:17Z",
          },
        ],
      },
    });
    const start = lines.indexOf("deepseek");
    expect(lines[start + 1]).toContain("session");
    expect(lines[start + 2]).toContain("mystery");
  });

  test("aligns bars in the same column across families", () => {
    const lines = render(FIXTURE);
    const rows = lines.filter((l) => l.startsWith("  "));
    const barIdx = rows.map((l) => {
      const filled = l.indexOf("█");
      return filled === -1 ? l.indexOf("░") : filled;
    });
    expect(new Set(barIdx).size).toBe(1);
  });

  test("rolls minutes up to hours instead of emitting 60m", () => {
    const lines = render({
      generated_at: "2026-08-03T16:00:00Z",
      usage: {
        claude: [
          {
            name: "5-hour",
            used_percent: 5,
            remaining_percent: 95,
            resets_at: "2026-08-03T20:59:40Z",
          },
        ],
      },
    });
    expect(lines.join("\n")).toContain("resets in 5h");
    expect(lines.join("\n")).not.toContain("60m");
  });

  test("trims trailing blank lines and skips empty families", () => {
    const lines = render({
      generated_at: "2026-08-03T16:00:00Z",
      usage: {
        claude: [],
        deepseek: [
          {
            name: "session",
            used_percent: 0,
            remaining_percent: 100,
            resets_at: "2026-08-03T17:21:17Z",
          },
        ],
      },
    });
    expect(lines).not.toContain("claude");
    expect(lines[lines.length - 1]).not.toBe("");
  });
});
