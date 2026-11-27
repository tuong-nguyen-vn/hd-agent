---
status: proposed
last_reviewed: 2026-11-27
superseded_by: []
related_code:
  - src/extensions/subagent/index.ts
  - src/shared/Jobs.ts
  - docs/pi-api.md
---

# Execution Plan: Background Agent Completion Notifications

Team: background-agent-tab-notifications
Path: Standard

## Outcome and Approach
Signal when background agents finish outside the active chat. Inside Herdr, use its native notification API; elsewhere emit a terminal bell. Include the number of unread completions when more than one completed, and clear unread state on return to that Pi session. See [discovery.md](discovery.md) and [approach.md](approach.md).

## Tasks
| # | Task | Blocked by | Ownership | Output contract |
|---|---|---|---|---|
| 1 | Implement per-session unread completion counting and host-aware signaling | — | Background subagent lifecycle and minimal shared state | Herdr toast includes unread count; terminal-only mode emits BEL. Preserve result delivery and exclude foreground/cancelled jobs. |
| 2 | Add regression tests and run full validation | 1 | Subagent/background tests and integration checks | Deterministic tests cover one, multiple, cancellation, host selection, and count reset; `bun run check` passes. |
| 4 | Create/update PR | 3 | GitHub PR | PR targets `main`, includes behavior summary and test evidence. |

## Execution Guidance
- Critical path: Task 1 implements the host selection, unread state, and notification signal before regression validation.
- Safe parallel work: None; the focus/session contract and implementation are coupled.
- Shared hubs or integration owners: Keep changes local to background subagent lifecycle and any strictly necessary shared state. Do not modify editor rendering unless API validation proves it is required.
- Protect uncommitted/user changes; do not force push or merge without a separate request.

## Verification Strategy
- Task checks: Inject fake session identity and notification sender to verify unread count and reset; keep process output out of focused unit tests.
- Integration checks: Confirm completion still sends the existing report message and Jobs status; failure/cancel do not notify.
- Final acceptance: `bun run check`; inspect PR state and diff after creation.

## Risks and Approval
- Accepted assumptions: Only background subagent success produces unread count; count is scoped to the owning process/session. Herdr toast delivery may be disabled by user config.
- Open risks: No portable terminal-only count badge; BEL is best effort and user terminals may ignore it. Herdr toast is host-wide, not a per-chat badge.
- User approval: User approved Herdr toast with pending count text inside Herdr and BEL outside Herdr on 2026-11-27.

## Live Plan Rule
If implementation cannot reliably identify the owning chat or send Herdr notification without blocking completion handling, update the plan and report the limitation before proceeding.
