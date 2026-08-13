# TUI Rendering

Read this when writing or changing a component's `render(width)`, a tool's `renderCall`/`renderResult`, or anything else the TUI draws every frame.

## The frame model

pi-tui re-renders **every** component in the session scrollback on every frame — and a frame fires on every keystroke. A component's `render(width)` is therefore a hot path multiplied by session length: at 200k+ tokens of context the scrollback holds hundreds of tool titles and output blocks, and per-frame work that looks cheap in isolation (a `wrapTextWithAnsi` call, a session-entry scan) becomes typing lag. Measured before caching was added: ~70ms per keystroke at 200k tokens, ~300ms at 500k.

## Rules

- **Cache rendered lines.** Mirror pi-tui `Text`: keep `cachedText`/`cachedWidth`/`cachedLines`, return the cached array on a hit, clear the cache in every setter and in `invalidate()`. `ToolTitle` and `makePrefixedBlock` in `src/shared/Renderer.ts` and the subagent views in `src/extensions/subagent/render.ts` are the canonical examples. A component whose inputs are fixed at creation only needs to key on `width`.
- **Return stable array references, and never mutate one you didn't build this call.** Stable refs let the TUI's line diff hit the identical-reference fast path and avoid GC churn. The flip side: a parent that concatenates a child's cached lines must copy first (`[...child.render(width)]`) — pushing into the child's cached array corrupts it (see `SubagentResult.render`).
- **Text measurement is expensive.** `wrapTextWithAnsi`, `truncateToWidth`, and `visibleWidth` run `Intl.Segmenter` grapheme segmentation per character. `visibleWidth` has a 512-entry cache for non-ASCII strings — a large session has far more unique lines than that, so assume every call is a cold call. Never call these per frame on content that hasn't changed; that is what the line cache is for.
- **No session scans in `render()`.** `sessionManager.getEntries()`, `getContextUsage()`, and friends are O(entries) per call. Compute such values into an event-invalidated cache (`message_end`, `agent_end`, `session_compact`, `session_tree`, `model_select`) and have `render()` read the cached value — see the footer stats cache in `src/extensions/footer/index.ts`.
- **Timers must self-stop when orphaned.** A component can be discarded mid-run (session switch, `/clear`) without any teardown hook. An animation interval must notice that `render()` has stopped being called and stop itself, restarting on the next render — see the spinner in `src/shared/Renderer.ts` (`SPINNER_ORPHAN_TIMEOUT_MS`).
- **Prototype patches keep the cache contract.** A `prototype.render` patch (user-message, silent-retry) re-runs on every frame even when the base component cached its output. Validate cheaply against the previous base lines (`===` per element hits the ref fast path) and reuse the previous result — see `src/extensions/user-message/index.ts`.

## When the tool renderer runs

Pi calls `renderCall`/`renderResult` only on state changes (`updateArgs`, execution start, result updates, expand toggle) — not per frame. Building components there is fine; it's the returned components' `render(width)` that must be cheap.
