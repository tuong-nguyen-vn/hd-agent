# Developer Guide

HD Agent is an opinionated yet minimal, Bun-native extension pack for [Pi](https://pi.dev/).

`bin/pim.ts` is a Bun launcher that resolves pi's `cli.js` and runs it under Bun, bypassing pi's Node shebang. Other pi extensions still work normally.

Dev setup: `bun link` puts `hd-agent` on PATH; `.pi/settings.json` registers HD Agent as a project-local pi package, so pi auto-loads it inside this repo. All three launcher bins (`hd-agent`, `amp-pi`, `pi`) point at the same Bun launcher. Launching plain `pi` (Node) instead of `hd-agent`/`amp-pi` trips HD Agent's Bun runtime guard.

## Commands

- `bun run check`: typecheck + test + lint + format. **Run after every change.**
- `bun dev`: `bun link` then launch `hd-agent` from this repo.
- `bun test src --only-failures`: run only previously-failing tests. Single test: `bun test src/path/to/file.test.ts`.
- `bun run typecheck` / `bun run lint` / `bun run format`: individual steps if you want to isolate.

Inside a running `hd-agent` session, `/reload` re-loads HD Agent after edits without restarting.

Telegram daemon: `hd-agent --mode telegram --install` (or `amp-pi`/`pi`) writes a user systemd/launchd unit and starts it. From Telegram, `/update` re-runs `bun install` (dev) or bumps the global Pi and HD Agent installs to latest (prod), then exits so the supervisor restarts the daemon. `hd-agent --mode telegram --uninstall` tears it down. See `src/telegram/Supervisor.ts`.

## Code Conventions

- Always prefer `type` over `interface`.
- Mark all data-shape fields `readonly` where possible.
- Default to `Bun.*` APIs over Node built-ins (`fs`, `child_process`, etc.), unless Bun does not have a similar API.
- Use comments sparingly, and only to explain why, not what or how.
- Use instance classes for stateful services and lifecycle objects. Avoid static-only classes outside `src/shared/`; prefer named functions for stateless module-local helpers.
- Shared utilities that cross module boundaries live in `src/shared/` and are exposed as a static-method class rather than a bare function. The filename must match the class name exactly (`Renderer.ts` exports `class Renderer`). Helpers with a single colocated caller stay as bare functions in lowercase files.
- Use relative imports only. Do not use path aliases (`paths` in tsconfig, `imports` in package.json, or `@/`/`#`/`~/` prefixes).
- When committing, check the commit history and use a similar semantic commit message.

## On-demand Docs

Read the topic doc only when its trigger applies to keep context lean.

| When you are… | Read |
| --- | --- |
| touching the Pi API surface (tools, events, ExtensionContext, commands, etc.) | [docs/pi-api.md](./docs/pi-api.md) |
| writing or changing a tool's `execute()` return, error handling, or truncation UX | [docs/tool-output.md](./docs/tool-output.md) |
| writing or changing a component's `render(width)`, `renderCall`/`renderResult`, or anything drawn per frame | [docs/rendering.md](./docs/rendering.md) |

If a task spans multiple areas, read each relevant doc.
