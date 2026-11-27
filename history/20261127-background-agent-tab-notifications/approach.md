---
status: proposed
last_reviewed: 2026-11-27
superseded_by: []
related_code:
  - src/extensions/subagent/index.ts
  - src/shared/Jobs.ts
---

# Approach: Background Agent Completion Notifications

## Recommendation
Use host-aware notification signaling from the background completion path: call Herdr's native notification CLI when running inside Herdr; otherwise emit a terminal BEL. Accumulate successful, unseen background completions per Pi session and include the count in Herdr toast text when it exceeds one. Clear unread count when that Pi session is activated again. Keep standard result delivery unchanged.

The Herdr integration uses the injected `HERDR_BIN_PATH` and is subject to configured toast delivery. Outside Herdr, BEL is best effort and count remains internal (no portable tab badge exists). The process has no reliable terminal-focus signal, so active status is tracked only by Pi's session lifecycle.

## Meaningful Alternatives
- Composer status line badge — easier to render, but does not match the requested terminal-tab attention behavior.
- Desktop notifications — useful across applications, but terminal support and permission behavior vary; not required by the request.

## Contracts and Integration
- Inputs: background completion event, originating Pi session identity, Herdr host environment, unread count state.
- Outputs: Herdr notification within Herdr or BEL elsewhere; include count when multiple completions are unread.
- Compatibility: avoid changing foreground agent behavior, cancellation, or custom result message contract.

## Risk and Evidence
| Area | Risk | Evidence or validation |
|---|---|---|
| Host integration | Medium | Confirm environment variables are available in Pi and Herdr's notification CLI is available. |
| Count lifecycle | Medium | Ensure count is scoped to originating chat and reset on return/session switch. |
| Session scoping | Medium | Background path captures parent context; inspect stable session identity across switch/reload. |
| Regression | Low | Existing background subagent tests capture `pi.sendMessage`; add assertions for attention behavior and unread accumulation/reset. |

## Migration, Operations, and Rollback
- Migration: none; state is in-memory.
- Observability: tests assert exact number of bell signals and unread-count transitions.
- Rollback: revert the feature commit; result delivery remains unchanged.

## Accepted Assumptions
- Only completed background agents create unread items in this scope.
- User-return clears unread count; per-user preference is not introduced.
