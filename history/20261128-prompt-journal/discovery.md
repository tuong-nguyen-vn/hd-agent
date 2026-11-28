---
status: proposed
last_reviewed: 2026-11-28
superseded_by: []
related_code:
  - src/extensions/activity-summary/index.ts
  - src/shared/Jobs.ts
---

# Discovery: Prompt Journal (memory)

## Outcome and Scope
- Desired behavior: the user's own prompt history across all pi/hd-agent sessions becomes a private, queryable journal. `/recall <query>` searches it; a `journal_search` tool lets the agent use it; `/memory audit` (phase 2) analyzes recurring patterns and proposes skills or doc updates.
- Users: single user (the machine owner). Memory is per-user, never shared.
- Non-goals: no agent-generated "learnings" file (rejected: stale second source of truth), no committing memory to any repo, no cloud sync, no auto-audit without user invocation.

## Evidence
- Pi already records every session as JSONL at `~/.pi/agent/sessions/<mangled-cwd>/<timestamp>_<uuid>.jsonl`. First line: `{"type":"session","id","timestamp","cwd"}`.
- User prompts are entries `{"type":"message","message":{"role":"user","content":[{"type":"text","text":...}]}}` with `id`, `parentId`, `timestamp`. VERIFIED by direct inspection of `~/.pi/agent/sessions/--Users-datgs-Workspace-HD-pim-agent--/2026-11-19T09-47-51-252Z_*.jsonl`.
- Total corpus is ~283 MB across 18 project dirs, but user prompts are a small fraction — the index only needs prompts, not tool output.
- Some user messages are injected tool results or system-generated; entries with role `user` whose content comes from `pi.sendMessage` custom types need filtering (e.g. subagent results). HYPOTHESIS: check `customType` or message shape during implementation.
- Market validation: `pi-hermes-memory` (25k downloads/mo) offers `session_search` — demand for this exists in the pi ecosystem.
- hd-daily-viewer skill already navigates daily artifacts at `~/.hd/` — journal complements it, does not replace.

## Index Scope (user-decided)
- One global index at `~/.hd/memory/index.db` covering all projects, with per-project filtering/ranking. Cross-project pattern detection is a feature: the same habit across repos should surface once in audit.
- Search ranks the current project's prompts first.

## Privacy Contract (user-decided)
- Index and any derived data live outside repos: `~/.hd/memory/` (index.db + per-project meta).
- Nothing is written into project directories; nothing is committable.
- Audit reports quote prompt evidence locally only; proposed skill/AGENTS.md updates must not copy private prompt text automatically — user reviews before anything becomes a shared artifact.

## Existing Contracts and Patterns
- Extensions load per-session via hd-agent; commands via `pi.registerCommand`; tools via `Tools.register` pattern used in `src/extensions/subagent/index.ts`.
- Bun-native: prefer `bun:sqlite` (built-in, zero deps) over external search services.
- hd-search skill exists for code/docs/ISO artifacts with project-scoped indexes — journal is a separate, simpler concern; reuse is optional, not required.

## Constraints
- Indexing must be incremental (283 MB cold scan would be slow; mtimes + sizes let us skip unchanged files).
- JSONL files are append-only; entries never mutate, so re-reading only the tail after the last indexed byte offset is safe and cheap.
- Sessions written by concurrent pi processes: index reads must tolerate partial last lines.

## Facts, Assumptions, Questions
- Verified: session file format, location, growth pattern.
- Verified: `content` is a list of `{type:"text",text}` blocks for user prompts.
- Assumed: filtering non-human user-role messages is a matter of simple shape checks.
- Open: whether pi ever rotates/deletes old session files (if yes, index must handle disappearance).
