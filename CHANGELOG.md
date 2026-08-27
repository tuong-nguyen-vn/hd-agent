# Changelog

## Unreleased

## v0.16.0

### Features

- Cap the `ask_user_question` overlay at 70% of the terminal height so the assistant text that led to the question stays readable above it. The dialog is handed a terminal-rows value that matches the cap, so its scroll window and pi-tui's overlay slice agree and the footer is never cut off. Upstream `@juicesharp/rpiv-ask-user-question` bumped to 2.7.1 (terminal BEL when waiting, global note on the Submit tab, footer hints that follow `collapseKey`, `guidance.description`).
- Require user approval before consulting Oracle, and have the main agent reach for `web_search`/`web_fetch` on unfamiliar or possibly-stale library and API ground instead of answering from memory.
- Add a `context_paths` param to the subagent tool that inlines files (optionally `path:start-end` ranges) into the subagent prompt, and inline the sources a delegation brief cites — resolved directly or by unique suffix against `git ls-files`, whole when small, windowed around the citation when large — so Oracle stops rediscovering them. Briefs carry VERIFIED/HYPOTHESIS labels; caps are 64KB per file and 256KB total.
- Route Oracle to `gpt-5.6-sol` through the hdwebsoft gate: a subagent-only spec outside the provider registry, spawned with an HMAC gate token the gateway's oracle-gate plugin validates, held to a 272K context window.
- Give reasoning subagents a 300s stall leash (was 120s), matching the gateway's read timeout, so a long think no longer silently falls back to the next model candidate.
- Ease fullscreen wheel scrolling with a smooth-scroll extension: each notch adds 3 lines to an outstanding distance drained at 60fps with ease-out.
- Prewarm the diff highlighter from `session_start` and repaint once it lands.
- Add `gemini-3.7-flash` model to hdwebsoft-proxy and tuongnguyen-proxy (tuongnguyen-proxy now exposes only `gemini-3.7-flash` among Gemini Flash models). Default model references across settings, bundled agents, docs, and tests updated from `gemini-3.6-flash` to `gemini-3.7-flash`.
- Add `glm-5-3` (GLM thinking map simplified to high-only) and bump tuongnguyen-proxy's GLM model to 5.3. Rename the hdwebsoft-backup provider to Model Backup Free and add `x-preview-f-free` (Ox Alpha, 1M context) to it.
- Drop Claude and SWE models from the hdwebsoft-proxy registry, and remove the Devin provider together with the `pi-devin-auth` dependency.
- Symlink `pi` to the HD Agent launcher during installation.

### Bug Fixes

- Stop holding a pi `ExtensionContext` across session replacement in the subagent extension: Pi 0.84 invalidates the ctx on `/clear`, resume, fork, `/reload`, and quit, and the prewarm timer and long-running subagent retries were reading it afterwards and killing the process.
- Stop the first diff render of a session from crashing before the highlighter loads (the first edit/write/apply_patch showed only its title).
- Guard the launcher against a Bun that predates `EnvHttpProxyAgent` and have `install.sh` upgrade such a Bun instead of skipping it.
- Guard the silent-retry patch against a `@earendil-works/pi-ai` copy that does not export `isRetryableAssistantError`, which crashed session resume.
- Hide the `minimal` thinking level for Gemini 3.x Flash models to avoid a proxy 400.
- Drop the dead `find` tool from the Oracle and Search agents' tool lists (hd-agent's glob extension replaces it, so pi silently ran them with fewer tools).
- Disable detached mode on Windows to avoid spawning a console window.

## v0.15.1

### Bug Fixes

- Stop the tool-schema sanitizer from deleting properties whose name collides with a stripped JSON Schema keyword. `grep` and `glob` lost their required `pattern` argument (the model never saw it, so every call failed local validation with "missing required property: pattern") and `web_fetch` lost its optional `format`. Keys under `properties`/`$defs`/`patternProperties` are now treated as names, and `const`/`default`/`enum`/`examples` payloads are copied verbatim.

## v0.15.0

### Features

- Prewarm the subagent SDK loader in the background shortly after session start, cutting the first subagent call's setup from ~1.3s to under 100ms (the jiti extension-compile cache is process-global).
- Cap SKILL.md content at the 32KB output budget when invoking a skill, with a bracketed pointer to the read tool for the remainder, so an oversized skill cannot flood the model context.
- Cache the Telegram task-scheduler store in memory, invalidated by the tasks directory's mtime (external edits) and by the scheduler's own writes; the idle 10s poll now costs one `stat` instead of a readdir plus re-reading every task file.

## v0.14.0

### Features

- Cache rendered lines in all custom TUI components (tool titles, prefixed output blocks, subagent views, the user-message patch), fixing typing lag at large context: ~70ms per keystroke at 200k tokens and ~300ms at 500k drop to sub-ms steady state.
- Serve the powerline footer's cost/context stats from an event-invalidated cache instead of scanning the whole session on every keystroke.
- Stream oversized bash output incrementally to the spill file; memory now holds only an 8KB head plus a rolling 8KB tail regardless of command output size, with the full stream preserved on disk.
- Cap MCP tool results at the 32KB output budget; the full text is spilled to the cache with a read-tool pointer so external servers cannot flood the model context.
- Skip files over 10MB in grep directory scans (reported in the tool output); a directly-named oversized file errors with guidance to use bash grep/rg.
- Retain only ranges±context lines per grep-matched file (sparse array) instead of every matched file's full contents, and drop the duplicate normalize pass per file.
- Stop `read` rendering at the 32KB budget instead of formatting the entire range first (500k-line default-range read: 105ms → 0.3ms).
- Enforce a 1GB total budget on the spill cache alongside the 7-day TTL, evicting oldest spills first.
- Memoize per-entry markdown in the Telegram status renderer (was O(N²) markdown parsing per streaming turn) and coalesce per-turn cost writes to `state.json`; user-facing settings changes still flush immediately.
- Share one 1s debounce across both footer git-status triggers and never spawn two concurrent `git status` processes.
- Resolve reachable pi module copies once per process in `markdown-code`, `silent-retry`, and `user-message` instead of re-walking the filesystem on every `session_start`.
- Add `docs/rendering.md` documenting the per-frame render model and the line-cache contract for custom components.

### Bug Fixes

- Dispose the file-picker worker suggestion engine on cwd change/shutdown instead of leaking an OS worker thread per session switch; the engine is reused (catalog stays warm) when the root is unchanged.
- Self-stop orphaned tool-title spinner intervals when their component is discarded mid-run (session switch, `/clear`), restarting if the component is rendered again.
- Copy the subagent status view's cached lines before appending body output instead of mutating the cached array.

## v0.13.1

### Bug Fixes

- Bridge `ask_user_question`'s `rpiv:ask-user:blocked` event to Herdr's `herdr:blocked` channel so Herdr reports the pane as `blocked` (not `working`) while the questionnaire is open. Herdr treats pi as a full lifecycle authority and skips screen detection, so without this bridge the questionnaire's wait was invisible to Herdr's status and notifications.

## v0.13.0

### Features

- Add `deepseek-v4-pro` model to both hdwebsoft-proxy and tuongnguyen-proxy.
- Add `deepseek-v4-pro` to Oracle subagent model fallback list (before `gpt-5.6-luna`).

## v0.12.1

### Bug Fixes

- Strip unsupported JSON Schema keywords (`minimum`, `maximum`, `minLength`, etc.) from tool schemas sent to the API, fixing Anthropic 400 errors. Constraints are still enforced locally via `prepareArguments` validation and runtime clamping in each tool.

## v0.12.0

### Features

- Extend `view_media` with video, audio, and PDF support via Gemini `inlineData` payloads. Non-image media is routed exclusively through Gemini `google-generative-ai` models; non-Gemini providers are skipped with clear errors. A conservative 20 MB `MAX_INLINE_BYTES` cap applies to all media kinds. Images retain inline terminal preview; non-image media returns text description only.
- Replace per-startup OpenCode Zen network fetch with a static free-model list.
- Lazy-load `pi-mcp-adapter` and `pi-devin-auth` to `session_start` handlers.
- Convert all static value imports from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` to dynamic imports or type-only imports across 22 extensions and shared modules, eliminating the second-copy module load (~1000ms) that blocked the startup critical path. `createAgentSessionRuntime`: 2800-3400ms -> 829-1033ms (~70% reduction).
- Add `gpt-5.6-terra` model and update `gpt-5.6-sol` config.
- Store direct-to-model setting per model and simplify notify text.
- Fall back to next model candidate even after subagent made progress.
- Suppress `requestImmediateRender` and cancel pending renders on session reset.

### Bug Fixes

- Skip duplicate image preview when direct-to-model is enabled.

## v0.11.0

### Features

- Limit concurrent subagents to 4 per turn in system prompt.
- Add `/vision-direct` command to toggle direct-to-model image mode.
- Add `glm-5.2` model to hdwebsoft-proxy with 200k context window.
- Prohibit committing and pushing without explicit user request.

### Bug Fixes

- Correct glm-5-2 model id (dash not dot) in hdwebsoft-proxy.

## v0.10.0

### Features

- Use Mermaid diagrams by default instead of box-drawing for architecture/workflow visualizations.
- Encourage parallel Search subagents in system prompt for faster codebase discovery.
- Add subagent delegation guidance to system prompt with Oracle and Search agent patterns.
- Implement `rpiv-ask-user-question` extension with dynamic import and testing.
- Show provider name next to model in powerline footer.
- Add `mimo-v2.5` model to hdwebsoft-proxy with 1M context, 128K max output.
- Add `/usage-hdwebsoft` command showing hdwebsoft-proxy quota with recovery window and account count.
- Show loading spinner and success/failure mark in `/usage-hdwebsoft`.
- Enhance child process environment configuration for HERDR integration.
- Suppress retryable error text during auto-retry, show error once after exhaustion.
- Enhance Oracle agent capabilities and update tool descriptions.
- Introduce input type for model configuration in Devin provider.
- Increase context window for Tuong Nguyen proxy.
- Add one-command installer for easy setup.
- Enhance rendering logic for spinner animation in subagents.
- Add getting-started guide in English and Vietnamese.
- Document Exa/Jina API keys, thinking levels, and subagent model config.

### Bug Fixes

- Skip Mermaid code blocks in markdown-code patch to avoid double-processing.
- Wrap preload in try-catch so pi never crashes on version mismatch.
- Fallback to TUI class for pi-tui <0.84.0 in startup-render.
- Prefer bun-managed pi and always update it in install.sh.
- Patch `TuiBase.prototype` instead of removed `TUI` class.
- Adapt to pi 0.84.0 breaking changes.
- Suppress pi default UI flash on `/new` via `session_before_switch`.
- Cap long bash titles to stabilize scrolling.
- Declare `@juicesharp/rpiv-ask-user-question` dependency.
- Patch transitive npm vulnerabilities via overrides.
- Align usage bars in one column across families; roll minutes to hours.
- Label only the first reset as partial in `/usage-hdwebsoft` window.
- Render `/usage` widget as component so it is not truncated at 10 lines.
- Restore heavy braille spinner frames for non-subagent tools.
- Show hd-agent in the resume session hint instead of pi.
- Prefer `deepseek-v4-flash-free` as Search agent default model.
- Color subagent title and status line with accent while running.
- Replace `swe-1-7` with `deepseek-v4-flash` in defaults and comments.
- Skip unknown models in comma-separated list instead of throwing.
- Replace `claude-sonnet-5` with `grok-4.5-medium` as Oracle backup.
- Add `gpt-5.6-luna` as last Oracle fallback model.
- Force re-fetch launcher and harden Pi CLI discovery.
- Migrate legacy Pim installation.
- Update Devin model allowlist and remove deprecated entries.

### Improvements

- Bump `pi-coding-agent` peer dependency to `>=0.84.0`.
- Slow spinner cadence and spin while waiting to cut flicker.
- Guide Oracle delegation context in docs.
- Sync agents config example with subagent model list.
- Update Oracle and Search model lists in docs.
- Focus settings on exa, painter, viewMedia, and agents only.
- Remove powerline and Pi settings from getting-started guide.
- Mention all three launcher bins in AGENTS.md and CLAUDE.md.
- Rename Pim to HD Agent and update related documentation.
- Replace spinner frames with static markers for improved performance.
- Simplify spinner animation logic and update related tests.
- Remove `ACTIVE_YELLOW` constant and update subagent rendering logic.
- Update bundled subagent models and docs.

## v0.9.0

### Features

- Add `hd-agent` as an alias binary for `amp-pi`.
- Make skill names in tool titles clickable (OSC 8 hyperlink) — Cmd+Click opens the SKILL.md file directly in the editor.
- Implement skill discovery and invocation: parse `<available_skills>` from the system prompt, match by name/partial/typo, and load SKILL.md content once per session with deduplication.
- Transform `/skill:name` slash commands to bypass pi core's inline expansion, letting the model invoke the skill tool via system-prompt guidance.
- Add automatic session title generation.
- Add subagent collapsed body rendering with overflow indicator, tool-call titles, active tools display, and retry logic for transient failures with model fallback.
- Add `gpt-5.6-luna` to Oracle model fallback list and HDWEBSOFT proxy.
- Add HDWEBSOFT Backup provider with authorization handling.
- Add HDWEBSOFT and Tuong Nguyen proxy models.
- Add Claude Opus 4.8 and Gemini 3.5 Flash models.
- Add Gemini 3.1 Flash Image to painter fallback.
- Implement REST API fallback for ExaMCP web search client.
- Add Painter and ViewMedia tools for image generation and analysis with fallback mechanisms.
- Add Oracle and Search bundled subagents with model overrides.
- Add `read-session` tool for summarizing previous workspace sessions.
- Add `painter` tool with authorization header handling.
- Add `view-media` tool with terminal-only image preview.
- Add `glob` tool with tool visibility management for replaced tools.
- Add `web_search` tool.
- Add `mcp` tool via pi-mcp-adapter integration.
- Add Amp-style fenced code block rendering with syntax highlighting.
- Add ` AmpEditor` with Git state formatting and user message rendering enhancements.
- Add startup rendering with preload support.
- Add `/exit` command for graceful shutdown.
- Add system prompt behavioral blocks for improved prompt structure.
- Add prompt history management in AmpEditor.
- Add session reference (`@@session:<id>`) feature.
- Add file picker with repo-aware enumeration and nested Git ignore handling.
- Add spinner functionality in tool-call title rendering.
- Add `constrainedSampling` strict JSON Schema for bash, edit, write, apply-patch, and todo.
- Add `cwd` parameter to `bash`, `grep`, and `glob`.
- Add `<diagrams>` behavioral block to the system prompt.
- Inject `PI_*` session metadata into bash subprocesses.
- Enable clickable file links (OSC 8) in edit, write, apply-patch, and read tool titles.
- Add Telegram bot mode with rich message rendering, status narration, and systemd/launchd supervisor.
- Add `apply_patch` V4A patch tool for GPT/Codex models.
- Add thinking memory extension for model-level persistence.
- Add inference speed reporting (`/tps`).

### Bug Fixes

- Fix skill file path handling in rendering to link directly to SKILL.md.
- Fix launcher to skip project-local extensions inside pim-agent repos to avoid tool conflicts.
- Reduce `BODY_PREVIEW_LINES` from 20 to 15 for improved display.
- Hide 4 broken free opencode zen models.
- Fix Devin provider to synthesize grok-4-5-medium fallback to avoid startup warning.
- Fix subagent spinner redraw forcing scroll.
- Fix subagent tool-call lines exceeding terminal width.
- Fix init to swallow synchronous AbortError from Escape during streaming.
- Fix renderer to recognise herdr as hyperlink-capable via `HERDR_ENV`.
- Fix dependencies: pin protobufjs to patched 7.6.5, patch npm audit findings.
- Fix renderer to animate remaining tool markers.
- Fix bash to animate marker while running.
- Fix renderer to remove tool output guide lines.
- Fix theme: update custom message background and label colors in pim-dark theme.
- Fix `glob` result title formatting in `grep`.
- Respect excluded edit tools when using `apply_patch`.

### Improvements

- Rebrand from "AMP - Pi" to "HDWEBSOFT AGENTS".
- Bump `pi-coding-agent` peer dependency to `>=0.82.0`.
- Bump `engines.bun` to `>=1.2.21` for `Bun.stripANSI`.
- Complete gpt-5.6-sol thinking levels; bump gpt-5.6-luna context to 500k.
- Simplify `fetchOpencodeFreeModels` to remove proxy dependency.
- Update Devin model allowlist and configure new model overrides.
- Streamline session title generation and error handling.
- Unify spinner state management across subagent components.
- Enhance follow-up prompt handling for empty model responses.
- Enhance streamSimple handling for improved token usage accounting.
- Enhance markdown-code extension with path resolution, patching, and restore functionality.
- Enhance command execution with cwd support.
- Enhance command ranking and debounce Git refresh.
- Enforce `additionalProperties: false` in schema definitions for strict-mode compliance.
- Improve code readability and formatting across extensions.
- Refactor `view-media` to simplify image viewing messages.
- Refactor `session-title` error handling.
- Update `docs/pi-api.md` and `docs/tool-output.md`.
- Add `Paths.cwdSuffix()` and `Paths.requireAbsolute()` helpers.
- Add Levenshtein tests.
- Add `package-lock.json` for consistent installations.
- Register `pi` bin in launcher and skip self when resolving pi CLI.
- Enhance footer `fitBorder` to handle long ANSI and wide-character labels.
- Enhance user message handling with constructor resolution.
- Remove GPT-5.5 model from provider configuration.
- Add `pi-devin-auth` extension.
- Update session start event to show thinking label.
- Enhance diagram guidelines for clarity.
- Refine image viewing logic with improved fallback handling.
- Bundle default subagents.
- Update branding references from "Pi Improved" / "AMP Pi" to "HDWEBSOFT AGENTS".
- Rename launcher command from `pim` to `amp-pi` (with `hd-agent` alias).
- Remove powerline toggle.
- Add install instructions from fork in README.
- Add README badges and benchmark results.

## v0.7.0

### Features

- Add optional `cwd` parameter to `bash`, `grep`, and `glob` — run commands/searches in any directory without `cd … &&`. Accepts absolute paths only; relative paths are rejected with `Path must be absolute, not relative: …`. Title displays ` (in: <relative>)` when cwd differs from the workspace root.
- Add `<diagrams>` behavioral block to the system prompt — guides the model to produce box-drawing `diagram` code blocks for architecture/workflow/data-flow explanations, with alignment guidelines to reduce stray characters and text overflow.
- Inject `PI_*` session metadata (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`) into bash subprocesses via `buildBashEnv(ctx)`, so user scripts can adapt to the active session/model.
- Add `constrainedSampling: { type: 'json_schema', strict: 'prefer' }` to bash, edit, write, apply-patch, and todo — opts into provider-side strict JSON Schema generation, reducing argument errors on weaker models.
- Enable clickable file links (OSC 8 hyperlinks) in edit, write, and apply-patch tool titles — Alt+Click now works consistently with read.

### Improvements

- Bump `pi-coding-agent` peer dependency to `>=0.82.0`.
- Add `Paths.cwdSuffix()` and `Paths.requireAbsolute()` helpers.
- Update `docs/pi-api.md` and `docs/tool-output.md`.

## v0.6.0

### Features

- Update pi alongside pim in prod Telegram `/update` and report its version (1b7e3e4)

### Improvements

- Bump `pi-coding-agent` to 0.80.10 and migrate to the ModelRuntime API (54d7046)

## v0.5.0

### Features

- Render Telegram status narration as Markdown with message length caps (cafa871)

### Bug Fixes

- Require double tildes for Telegram strikethrough formatting (#12)

## v0.4.0

### Features

- Render Telegram replies and live status as Bot API 10.1 rich messages (b1afcb9)
- Reuse Exa MCP sessions and throttle free-tier web searches (60eef60)

### Improvements

- Document Telegram rich text formatting (1953b3c)

## v0.3.0

### Features

- Run file picker suggestion ranking in a worker thread to improve performance for large number of files (cebda6d)
- Scope file picker ranking to directory children and add literal fast path to improve performance for large number of files (b2d388d)
- Add a literal fast path to improve `grep` performance for large number of files (a50fee3)
- Add repo-aware file enumeration with accurate nested Git ignore handling (131483e)
- List directories in the file picker and avoid adding a trailing space on tab completion (c47deff)

### Bug Fixes

- Respect excluded edit tools when using `apply_patch` (556f991)

### Improvements

- Bump dependencies (4920aaf)
- Add edit micro benchmark and results (13541c1, 500f749)
- Add README badges (0baf591)

## v0.2.0

### Features

- Add the `apply_patch` V4A patch tool for GPT/Codex models (d0b559d)
- Show `apply_patch` operations and diff stats in Telegram status updates (5026999)
- Render `read` output with muted line numbers (0ff35ab)

### Bug Fixes

- Format `glob` targets in `grep` result titles (802026c)
- Use a hardcoded `settings.json` for the Terminal Bench 2 adapter (01f5d7f)

### Improvements

- Add the release skill (c0d9b1e)
- Refine tool descriptions (a038607)
- Add the release workflow (00150cd)
- Document `apply_patch` usage (96f52cf)
- Update Telegram feature documentation (ac2126b)
- Refresh the demo asset (76ecdbc)
- Add `Levenshtein` tests (e1928f3)
- Refresh project and benchmark READMEs (b93294c)

## v0.1.0

### Features

- Initial release
