import { describe, expect, test } from "bun:test";
import { buildAuditPrompt, sampleForAudit } from "./audit";
import type { JournalSearchResult } from "./indexer";

function prompt(text: string, cwd = "/proj"): JournalSearchResult {
  return {
    text,
    timestamp: "2026-11-28T10:00:00Z",
    cwd,
    sessionFile: "s.jsonl",
  };
}

describe("memory audit", () => {
  test("samples by topic when matches exist", () => {
    const hits = [prompt("export docx")];
    const recent = [prompt("recent one"), prompt("recent two")];
    const sample = sampleForAudit(
      () => hits,
      () => recent,
      "docx"
    );
    expect(sample).toEqual(hits);
  });

  test("falls back to recent prompts when topic has no matches", () => {
    const recent = [prompt("recent one")];
    const sample = sampleForAudit(
      () => [],
      () => recent,
      "nothing-matches-this"
    );
    expect(sample).toEqual(recent);
  });

  test("uses recent prompts when no topic is given", () => {
    const recent = [prompt("a"), prompt("b")];
    const sample = sampleForAudit(
      () => {
        throw new Error("search should not be called");
      },
      () => recent,
      undefined
    );
    expect(sample).toEqual(recent);
  });

  test("audit prompt forbids verbatim copying into proposals", () => {
    const text = buildAuditPrompt([prompt("some secret prompt")], undefined);
    expect(text).toContain("NEVER copy raw prompt text");
    expect(text).toContain("## Patterns");
    expect(text).toContain("## Proposals");
    expect(text).toContain("## Outliers");
  });

  test("audit prompt includes numbered samples with project names", () => {
    const text = buildAuditPrompt(
      [prompt("làm widget", "/work/pim-agent")],
      "widget"
    );
    expect(text).toContain('the topic "widget"');
    expect(text).toContain("(pim-agent)");
    expect(text).toContain("làm widget");
  });

  test("long prompts are truncated in the audit sample", () => {
    const long = "x".repeat(300);
    const text = buildAuditPrompt([prompt(long)], undefined);
    expect(text).not.toContain(long);
    expect(text).toContain("…");
  });
});
