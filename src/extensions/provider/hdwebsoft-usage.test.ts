import { describe, expect, test } from "bun:test";
import { renderUsageReport, type UsageData } from "./hdwebsoft-usage";

const FIXTURE: UsageData = {
  generated_at: "2026-08-03T15:57:03.369126496Z",
  usage: {
    claude: [
      {
        name: "5-hour",
        used_percent: 11,
        remaining_percent: 89,
        resets_at: "2026-08-03T20:40:00Z",
      },
      {
        name: "7-day",
        used_percent: 63,
        remaining_percent: 37,
        resets_at: "2026-08-09T20:00:00Z",
      },
    ],
    gemini: [
      {
        name: "5-hour",
        used_percent: 0,
        remaining_percent: 100,
        resets_at: "2026-08-03T20:34:37Z",
      },
      {
        name: "weekly",
        used_percent: 33,
        remaining_percent: 67,
        resets_at: "2026-08-07T10:35:58Z",
      },
    ],
    opencode: [
      {
        name: "monthly",
        used_percent: 5,
        remaining_percent: 95,
        resets_at: "2026-09-02T06:27:36Z",
      },
      {
        name: "session",
        used_percent: 9,
        remaining_percent: 91,
        resets_at: "2026-08-03T17:21:17Z",
      },
      {
        name: "weekly",
        used_percent: 5,
        remaining_percent: 95,
        resets_at: "2026-08-09T23:59:12Z",
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
  test("sorts opencode buckets session → weekly → monthly", () => {
    const lines = render(FIXTURE);
    const start = lines.indexOf("opencode");
    const rows = lines.slice(start + 1).filter((l) => l.startsWith("  "));
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
    const line = lines.find((l) => l.includes("63%"))!;
    const bar = line.match(/[█░]{10}/)![0]!;
    expect(bar).toBe("██████░░░░");
    const zero = lines.find((l) => l.includes("0%"))!;
    expect(zero.match(/[█░]{10}/)![0]).toBe("░░░░░░░░░░");
  });

  test("renders relative resets from a fixed reference time", () => {
    const lines = render(FIXTURE);
    const session = lines.find((l) => l.includes("session"))!;
    expect(session).toContain("resets in 1h 21m");
    const monthly = lines.find((l) => l.includes("monthly"))!;
    expect(monthly).toContain("resets in 29d 14h");
  });

  test("skips families the API did not return", () => {
    const lines = render({
      generated_at: "2026-08-03T15:57:03Z",
      usage: {
        claude: FIXTURE.usage.claude!,
      },
    });
    expect(lines.join("\n")).not.toContain("gemini");
    expect(lines.join("\n")).not.toContain("opencode");
  });

  test("keeps unknown bucket names after known ones", () => {
    const lines = render({
      generated_at: "2026-08-03T15:57:03Z",
      usage: {
        opencode: [
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
    const start = lines.indexOf("opencode");
    expect(lines[start + 1]).toContain("session");
    expect(lines[start + 2]).toContain("mystery");
  });

  test("trims trailing blank lines and skips empty families", () => {
    const lines = render({
      generated_at: "2026-08-03T15:57:03Z",
      usage: {
        claude: [],
        opencode: [
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
