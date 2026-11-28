---
status: proposed
last_reviewed: 2026-11-28
superseded_by: []
related_code:
  - src/extensions/subagent/index.ts
  - src/extensions/activity-summary/index.ts
---

# Execution Plan: Prompt Journal

## Task 1: Indexer core (phase 1)

**Goal:** `src/extensions/journal/indexer.ts` — incremental indexer of pi session JSONL files into a SQLite FTS5 database at `~/.hd/memory/index.db`.

**Outcomes and constraints:**
- `bun:sqlite` only; no new dependencies.
- Schema: `prompts(session_file, entry_id, cwd, timestamp, text)` + FTS5 virtual table; `files(path, byte_offset, mtime)` for incremental state.
- Scan: enumerate `~/.pi/agent/sessions/**/*.jsonl`; for each file compare mtime/size with stored state; read only new bytes; tolerate a partial trailing line (drop it, keep offset before it).
- Extraction: entries with `type === "message"` and `message.role === "user"`; join text content blocks; skip empty/non-human shapes (verify what injected messages look like during implementation and document the filter).
- Insert with entry-id dedupe (re-scan safety).
- Public API: `indexSessions(): Promise<{indexed: number}>` and `searchPrompts(query, limit): SearchResult[]` where a result carries text snippet, timestamp, cwd, session file.

**Acceptance evidence:** unit tests with fixture JSONL files in a temp dir covering: extraction, dedupe, incremental tail reads, partial-line tolerance, FTS queries, missing-directory tolerance, and concurrent partial-write recovery. `bun test src/extensions/journal` green.

**File scope:** `src/extensions/journal/indexer.ts`, `indexer.test.ts`.

## Task 2: Extension wiring — journal_search + /memory recall (phase 1)

**Goal:** `src/extensions/journal/index.ts` registering the `journal_search` tool and the `/memory recall <query>` command; lazy incremental re-index on `session_start`. The command is the deterministic, LLM-free lookup path showing raw prompt evidence directly; natural-language questions route through the tool for a summarized answer. Command naming follows the `/memory` family namespace (`/memory on|off`, `/memory recall`, `/memory audit`).

**Outcomes and constraints:**
- On `session_start`: fire-and-forget `indexSessions()` (unref'ed, errors swallowed to a single warning notify — never break the session).
- `journal_search` tool: params `{query: string, limit?: number}`; returns capped results (default 10) with timestamp, project path, session file basename, snippet. Description written so the agent uses it when the user references their own past requests ("I asked before…", recall-style questions).
- `/memory recall <query>`: runs the same search deterministically and renders matching prompts with timestamps and project paths in chat; empty query shows usage.
- No-op gracefully when the sessions dir does not exist or index is empty.

**Acceptance evidence:** harness-style tests mirroring `src/extensions/activity-summary/index.test.ts` (mock pi/ctx, emit events, assert tool registration, `/memory recall` output for a fixture query, empty-query usage, empty-index behavior). Full `bun run check` green.

**File scope:** `src/extensions/journal/index.ts`, `index.test.ts`.

## Task 3: Status indicator + /memory on|off (phase 1)

**Goal:** visible memory state on the composer powerline, plus `/memory on|off` toggle.

**Outcomes and constraints:**
- Reuse the established ActivityLine-style bridge pattern: a `JournalLine` globalThis-backed bridge in `src/shared/` (same `Symbol.for` trick — module duplication across pi copies) that the journal extension writes and `AmpEditor` reads, rendering a short muted caption in the bottom border, on the right side before the path/git segment (user-approved layout). Left side stays reserved for the activity caption.
- State persisted across sessions: enabled flag in `~/.hd/memory/state.json` (not project settings — memory is user-scoped).
- `/memory` bare toggles; `/memory on` and `/memory off` explicit. Default is **on**.
- When off: indexing stops (indexSessions is a no-op), the indicator shows off state or hides, `/recall` and `journal_search` still work on existing data but say indexing is paused so results may be stale — they do NOT become unavailable, since the data is already the user's own history.
- Clicking the indicator toggles memory on/off directly (same click-range mechanism the activity caption already uses in AmpEditor.handleMouse). No review widget — the click is the whole interaction.

**Acceptance evidence:** tests for toggle persistence, indexing skip when off, indicator text reflects state, and click-to-toggle invoking the same state flip as `/memory`. Full `bun run check` green.

**File scope:** `src/shared/JournalLine.ts`, `src/extensions/journal/state.ts`, wiring in `index.ts`, minimal render addition in `src/extensions/footer/AmpEditor.ts`.

## Task 4: Memory audit command (phase 2)

**Goal:** `/memory audit [topic]` — pattern analysis over the journal with privacy-safe proposals.

**Outcomes and constraints:**
- Samples prompts from the index: topic-filtered FTS query when a topic is given, otherwise the most recent N (default ~200) prompts across a time window.
- Sends the sample to the agent with instructions to cluster repeated requests/corrections and output: pattern, frequency, evidence quotes (locally displayed), and concrete proposals (skill create/update, AGENTS.md patch, doc change) written in generalized language that does not copy private prompt text.
- Output rendered as a report in chat; no automatic file modifications. The user decides what becomes a shared artifact.
- Documented privacy contract in a comment and in the command description.

**Acceptance evidence:** tests for sampling logic, prompt construction, privacy rule (no raw prompt text in generated proposals), and empty-index behavior (mock the index); manual live run of `/memory audit` producing a sensible report.

**File scope:** `src/extensions/journal/audit.ts`, `audit.test.ts`, wiring in `index.ts`.

## Dependencies and ordering
- Task 1 → Task 2 → Task 3 → Task 4 strictly sequential (same files area, each builds on the previous).
- Single worker sufficient; no parallelization needed.

## Integration evidence
- After all tasks: live end-to-end verification through Herdr — spawn a fresh hd-agent in a new Herdr pane (`herdr` CLI), have that agent ask about a phrase typed in an earlier session, confirm `~/.hd/memory/index.db` was created and the phrase is found. `/memory audit` on a real topic produces a report; clicking the memory indicator toggles state. Full `bun run check` green.

## Test coverage requirements (user-mandated)
Every task ships with its tests in the same commit; no untested task is complete. At minimum: extraction/indexer unit tests, wiring harness tests, toggle/state persistence tests, click-toggle tests, audit sampling + privacy tests. `bun run check` (typecheck + test + lint + format) must be green after each task commit.

## Rollback
- Remove `src/extensions/journal/`, delete `~/.hd/memory/`. Nothing else is touched.
