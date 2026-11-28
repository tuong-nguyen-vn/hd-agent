---
status: proposed
last_reviewed: 2026-11-28
superseded_by: []
related_code:
  - src/extensions/activity-summary/index.ts
---

# Approach: Prompt Journal

## Chosen approach

A new extension `src/extensions/journal/` with three layers, delivered in two phases.

**Phase 1 — index + recall**
- `indexer.ts`: scans `~/.pi/agent/sessions/**` JSONL files incrementally. Per-file state (byte offset, mtime) in a SQLite DB at `~/.hd/memory/index.db` using `bun:sqlite` with FTS5 for full-text search. Extracts human user prompts only: `role === "user"`, content text blocks, excluding tool-result/injected messages (filtered by shape heuristics verified during implementation).
- Rows: `(session_file, entry_id, cwd, timestamp, text)`.
- Re-index triggers: on `session_start` (cheap incremental pass — only reads file tails after stored offsets). No background daemon; no per-message hooks needed since prompts are recorded by pi itself.
- `journal_search` tool: FTS5 query over the index, returns matching prompts with timestamp, project, session ref, and a short snippet. Cap results, rank by recency + relevance.
- `/recall <query>` command: same search, formatted for the user in chat, with session ids so the user can `pi --session <id>` or reference `@@session:`.

**Phase 2 — memory audit**
- `/memory audit [topic]` command: samples prompts from the index (optionally topic-filtered, time-windowed), asks the agent to cluster repeated requests/corrections, and produce a report with:
  - pattern description + frequency + evidence quotes (local display only)
  - concrete proposal: new/updated skill, AGENTS.md patch, or doc change
- Strict privacy rule: quotes stay in the local report; proposed artifacts contain generalized rules only, reviewed by the user before any commit.

## Alternatives considered

- **pi-hermes-memory-style MEMORY.md learnings**: rejected with the user — distillations go stale and become a second source of truth contradicting curated docs. The journal keeps facts; knowledge promotion happens through audit into curated artifacts.
- **Reuse hd-search indexes**: possible later; the journal is a single-table FTS problem, and coupling to the search-settings machinery adds complexity for no current benefit.
- **LLM embeddings/semantic search**: out of scope for v1 — FTS5 covers keyword recall well; audit uses the LLM for synthesis anyway. Can be added behind the same tool interface later.

## Risk assessment
- Novelty: low — format verified, SQLite FTS is standard, extension patterns established in-repo.
- Blast radius: none on existing behavior; a pure addition. Worst case the index is stale or corrupt — delete `~/.hd/memory/index.db` and re-index.
- Privacy: the core sensitive point. Mitigations: data never leaves `~/.hd/memory/`; audit evidence is display-only; documentation of the privacy contract in the extension README section of the plan.
- Performance: incremental tail reads are O(new bytes); the first cold index of 283 MB is a one-time cost run once per session_start lazily, reading only user-prompt lines. Estimate: a few seconds, off the critical path (fire-and-forget after session start, like the subagent prewarm).
- Reversibility: trivial — remove the extension, delete the db.

## Validation
- Unit tests with fixture JSONL: extraction filters, incremental indexing, tolerant reads of partial lines, FTS query behavior.
- Live check: run a real hd-agent session, `/recall` a known past prompt phrase.
