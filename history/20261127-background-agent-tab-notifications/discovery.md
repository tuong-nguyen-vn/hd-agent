---
status: proposed
last_reviewed: 2026-11-27
superseded_by: []
related_code:
  - src/extensions/subagent/index.ts
  - src/shared/Jobs.ts
  - src/extensions/footer/AmpEditor.ts
---

# Discovery: Background Agent Completion Notifications

## Outcome and Scope
- Desired behavior: Signal on the terminal tab when a background subagent finishes while the user is away; show one bell for one completion and a bell plus count for multiple unseen completions.
- Users: People running HD Agent in multiple terminal tabs.
- Non-goals: Notify for foreground agents, failed/cancelled background work unless requested later, or change subagent result delivery.

## Evidence
- `src/extensions/subagent/index.ts:129-180` creates background jobs and calls `notify()` after completion or failure.
- `src/extensions/subagent/index.ts:221-245` delivers custom result messages to the chat but has no terminal attention signal.
- `src/shared/Jobs.ts:50-155` tracks process-local background jobs; it has no per-session unread count.
- User screenshot shows terminal tab titles with a bell indicator in Devin, absent from HD Agent.
- Installed Pi API exposes `ctx.ui.setTitle()` and `ctx.ui.onTerminalInput()`, so a plugin can change titles and observe focus reports; source signatures are in `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:92-93,129-130`.
- Herdr's docs say pane-local OSC title writes stop at Herdr, and the outer title follows the focused pane terminal title. Herdr also has a notification API, but suppression is only guaranteed for the active tab and delivery depends on user config.
- External `pi-ghostty-tab` package documents BEL (`\x07`) as a Ghostty tab attention signal, but Herdr's own notification API is a better fit.

## Existing Contracts and Patterns
- Background completions are reported with `pi.sendMessage(..., { triggerTurn: true })`.
- `Jobs` is process-local and shared by the extension bundle.
- Footer/editor UI is managed by a custom editor; do not modify it unless required for the chosen solution.

## Constraints
- Technical: count must be scoped to the parent chat/session; multiple background completions must accumulate while that chat is not active.
- Operations: terminal/host decides whether BEL marks a tab or bounces attention; tests should verify emitted control signal and count logic.
- UI standard: no formal UI standard found; follow the screenshot and terminal-native behavior.

## Facts, Assumptions, Questions
- Verified: Background subagents are explicitly opted into via `background: true`; they already have a completion path.
- Assumed: Herdr toast delivery is enabled when users expect a Herdr notification. Completion count is shown in the toast text, not as a native tab badge.
- Verified: Pi has terminal focus input reporting and title-setting APIs.
- Verified: Herdr CLI notification has no documented pane-target argument; notification delivery is host-wide and suppresses toasts for the active tab.
- Open: Herdr toast delivery is controlled by user configuration.

## Clarifications
- User chose unread semantics: count completions while away and clear it when returning to that chat.
- User prefers native terminal tab attention over a composer-only icon.
