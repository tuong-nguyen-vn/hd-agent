import type { JournalSearchResult } from "./indexer";

export const AUDIT_MAX_SAMPLE = 200;
export const AUDIT_PROMPT_TRUNCATE = 160;

/**
 * Build the audit analysis prompt sent to the agent. The user's raw prompts
 * are evidence for clustering only; the instructions forbid copying them
 * verbatim into artifact proposals because journal content is private and
 * must never leak into committable docs or skills.
 */
export function buildAuditPrompt(
  samples: readonly JournalSearchResult[],
  topic: string | undefined
): string {
  const scope = topic
    ? `the topic "${topic}"`
    : "their recent activity across projects";
  const lines = samples.map((s, i) => {
    const date = s.timestamp.slice(0, 10);
    const project = s.cwd.split("/").pop() ?? s.cwd;
    const text =
      s.text.length > AUDIT_PROMPT_TRUNCATE
        ? `${s.text.slice(0, AUDIT_PROMPT_TRUNCATE)}…`
        : s.text;
    return `${i + 1}. [${date}] (${project}) ${text.replace(/\n/g, " ")}`;
  });

  return `You are auditing the user's private prompt journal — a record of what they actually asked coding agents over time. Below are numbered samples from ${scope}.

SAMPLES:
${lines.join("\n")}

TASK: Identify recurring patterns in how the user works with agents, then produce a memory audit report with exactly these sections:

## Patterns
For each repeated behavior (2+ occurrences): what the user repeatedly asks for, the approximate frequency in the sample, and which sample numbers evidence it (e.g. "samples 3, 17, 42"). Look especially for: repeated task shapes, repeated corrections they give agents, repeated manual steps that could be automated, and repeated phrasing that signals an unmet workflow need.

## Proposals
For each pattern worth acting on, propose ONE concrete improvement, in priority order:
- a new or updated skill (name it, sketch its trigger and behavior), or
- a patch to project documentation (AGENTS.md or similar), or
- a workflow/tooling change.
Write proposals in generalized language. NEVER copy raw prompt text into a proposal — the journal is private; proposals may end up in shared, committable artifacts. Quote evidence only in the Patterns section as sample numbers, not verbatim text.

## Outliers
Anything unusual worth the user's attention (one-off but high-value requests, signs of friction).

If the sample shows no meaningful repetition, say so plainly instead of inventing patterns.`;
}

export function sampleForAudit(
  search: (query: string, limit: number) => JournalSearchResult[],
  recent: (limit: number) => JournalSearchResult[],
  topic: string | undefined,
  maxSample = AUDIT_MAX_SAMPLE
): JournalSearchResult[] {
  if (topic) {
    const results = search(topic, maxSample);
    if (results.length > 0) {
      return results;
    }
  }
  return recent(maxSample);
}
