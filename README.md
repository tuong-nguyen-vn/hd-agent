<!-- omit in toc -->
# HD Agent

[![npm version](https://img.shields.io/npm/v/hd-agent?style=flat-square)](https://www.npmjs.com/package/hd-agent)
[![npm downloads](https://img.shields.io/npm/dm/hd-agent?style=flat-square)](https://www.npmjs.com/package/hd-agent)
[![license](https://img.shields.io/npm/l/hd-agent?style=flat-square)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun&style=flat-square)](https://bun.com)

_**HD Agent extends Pi with an opinionated, Bun-native agent experience.**_

A Bun-native extension pack for [Pi](https://pi.dev/): web access, subagents, revamped core tools, ANSI-compatible themes, fzf-style completions, Telegram mode, and more. Preliminary score of [37.8% on Terminal-Bench 2.0](#terminal-bench-20) with locally hosted Qwen3.6-35B, rivalling Claude Code + Sonnet 4.5.

- [Quick Start](#quick-start)
  - [Enabling/Disabling Extensions](#enablingdisabling-extensions)
  - [API Keys (Optional)](#api-keys-optional)
  - [HD Agent Configuration](#hd-agent-configuration)
  - [Recommended Pi Settings (Optional)](#recommended-pi-settings-optional)
- [Why HD Agent?](#why-hd-agent)
  - [Lean System Prompt](#lean-system-prompt)
  - [Model-Aware Tools](#model-aware-tools)
  - [Terminal-Bench 2.0](#terminal-bench-20)
- [Agent Tools](#agent-tools)
- [Terminal UI](#terminal-ui)
- [Telegram Bot](#telegram-bot)
  - [Setup](#setup)
  - [Commands](#commands)
  - [Features](#features)
- [Changelog](#changelog)
- [Developing](#developing)

![HD Agent Demo](https://raw.githubusercontent.com/tuong-nguyen-vn/hd-agent/refs/heads/main/assets/demo.webp)

## Quick Start

Ensure that you have [Pi](https://pi.dev/docs/latest/quickstart) and [Bun](https://bun.com/docs/installation) already installed. If not, install them first (_or ask your agent to do it for you_). For all things related to Pi, refer to [Pi's comprehensive docs](https://pi.dev/docs/latest).

```sh
# Install HD Agent as a Pi extension and Bun-native launcher:
pi install git:github.com/tuong-nguyen-vn/hd-agent
bun install -g github:tuong-nguyen-vn/hd-agent

# Launch HD Agent:
hd-agent
```


> [!IMPORTANT]
> **Use `hd-agent` instead of `pi` after installing HD Agent.** The `hd-agent` command is a drop-in replacement for `pi` that [runs Pi via Bun](./bin/pim.ts), enabling Bun-specific APIs. Existing Pi behaviour and extensions should continue to work normally.

The global install also registers a `pi` bin pointing at the same launcher, so tools that hardcode `pi` (e.g. [herdr](https://herdr.dev) resuming an agent pane with `pi --session <file>`) still get the Bun runtime. This only takes effect when Bun's global bin directory comes before Pi's own bin directory on your `PATH`; otherwise keep calling `hd-agent` directly. HD Agent skips its own bin when locating the real Pi CLI, so there is no recursion.

If `hd-agent` cannot locate Pi, make sure `pi` is on your `PATH`, or set:

```sh
PIM_PI_CLI=/path/to/pi/dist/cli.js hd-agent
```

### Enabling/Disabling Extensions

HD Agent ships a collection of extensions which are all enabled by default. To disable specific ones that don't suit your needs, run `hd-agent config` and toggle them there.

Some HD Agent extensions can be toggled directly within the TUI as well: `/tps` for inference speed reporting.

### API Keys (Optional)

HD Agent's web tools use [Exa](https://exa.ai) for searching the web and [Jina](https://jina.ai/reader/) for fetching websites as Markdown. These tools still work without API keys, but are subject to the following rate limits (as of May 2026):

- Exa - 1,000 requests per month
- Jina - 20 requests per minute

For heavier usage, add API keys to `~/.pim/settings.json`:

```json
{
  "exa": {
    "apiKey": "api_key_here"
  },
  "jina": {
    "apiKey": "api_key_here"
  }
}
```

Environment variables override `settings.json` when present:

```sh
EXA_API_KEY='api_key_here' JINA_API_KEY='api_key_here' hd-agent
```

### HD Agent Configuration

HD Agent-specific settings live in `~/.pim/settings.json`. All fields are optional;
the example below shows every currently supported setting:

```json
{
  "tps": {
    "enabled": false
  },
  "powerline": {
    "enabled": true
  },
  "exa": {
    "apiKey": ""
  },
  "jina": {
    "apiKey": ""
  },
  "painter": {
    "model": "gpt-image-2"
  },
  "viewMedia": {
    "model": "gemini-3.6-flash"
  },
  "agents": {
    "Oracle": "gpt-5.6-sol",
    "Search": "gemini-3.6-flash"
  }
}
```

`painter.model` and `viewMedia.model` only select the dedicated model. HD Agent finds
that model in `~/.pi/agent/models.json` and uses the provider's `baseUrl`,
`apiKey`, and `api`. If the model or required provider fields are missing, the
tool reports which Pi model configuration needs to be added.

> [!NOTE]
> **Bundled Subagents**: HD Agent ships with two built-in subagents—**Search** (fast, parallel code search) and **Oracle** (expert AI advisor for complex reasoning). These are available by default after installation. To customize them or add your own agents, place markdown configs in `~/.pi/agent/agents` (user-level) or `.pi/agents` (project-level). Project-level agents override user-level agents, which in turn override the bundled defaults (matching is case-insensitive).

For `viewMedia`, the provider's `api` controls the vision request protocol:

| `api` | Endpoint used |
| --- | --- |
| `openai-completions` | `<baseUrl>/chat/completions` |
| `google-generative-ai` | `<baseUrl>/models/<model>:generateContent` |
| `anthropic-messages` | `<baseUrl>/messages` when `baseUrl` ends in `/v1`, otherwise `<baseUrl>/v1/messages` |

For OpenAI-compatible proxies that serve Gemini or Claude model IDs through
`/v1/chat/completions`, set the provider's `api` to `openai-completions`; the
model name does not determine the wire protocol. `painter` requires its model's
provider to use `openai-completions` for `/images/generations` and
`/images/edits`.

### Recommended Pi Settings (Optional)

Add the following settings to your `~/.pi/agent/settings.json` for the best experience with HD Agent:

```json
{
  "quietStartup": true,
  "editorPaddingX": 1,
  "markdown": {
    "codeBlockIndent": ""
  }
}
```

## Why HD Agent?

HD Agent's philosophy is **opinionated but minimal**. Its goal is to improve the out-of-the-box experience for both users and agents, without sacrificing composability with other Pi extensions.

### Lean System Prompt

HD Agent's system prompt is just **~3K tokens** despite exposing 10+ tools, far leaner than alternatives like OpenCode (~10K) or Hermes (~16K).

This is achieved by having tool descriptions focus on _how_ to use each tool instead of prescribing _when_, since models already appear to internally encode when tools are needed, and prompting them to call tools can [suppress both necessary and unnecessary calls](https://arxiv.org/abs/2605.09252).

### Model-Aware Tools

LLMs are [increasingly post-trained](https://openai.com/index/introducing-codex) for specific agent harnesses, making tool schemas part of the model's learned interface. For text-file editing, Anthropic models are trained to use [string replacement operations](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool), while OpenAI models use [V4A patch operations](https://developers.openai.com/api/docs/guides/tools-apply-patch).

HD Agent keeps the active toolset model-aware instead of assuming one tool fits every LLM. It dynamically exposes the tools best suited to the selected model, giving each model the interface that best matches its learned behaviour while keeping the prompt lean.

### Terminal-Bench 2.0

| ID | HD Agent Version | LLM / Model | Results |
| --- | --- | --- | --- |
| [r1](./benchmarks/terminal_bench_2/results/r1/) | [`21d084d1`](https://github.com/tuong-nguyen-vn/hd-agent/tree/21d084d1) | `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` | **41.6%** (37/89) |
| [r2](./benchmarks/terminal_bench_2/results/r2/) | [`bfd792cf`](https://github.com/tuong-nguyen-vn/hd-agent/tree/bfd792cf) | `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` | **36.0%** (32/89) |
| [r3](./benchmarks/terminal_bench_2/results/r3/) | [`cd52f3a4`](https://github.com/tuong-nguyen-vn/hd-agent/tree/cd52f3a4) | `Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf` | **36.0%** (32/89) |

Preliminary aggregate score of **37.8%** from 3 independent runs. Each ran on an incremental build of HD Agent, though changes between runs were minor and none were tuned to the benchmark. HD Agent's `subagent` tool was disabled for all runs to keep each trial single-agent.

On average, HD Agent solves **~54% more tasks** than [little-coder](https://github.com/itayinbarr/little-coder) with the same Qwen3.6-35B model (37.8% vs 24.6%). This also places HD Agent in a similar tier to Claude Code + Sonnet 4.5 (40.1%), and above Codex + GPT-5-Mini (31.9%).

The Qwen3.6-35B model is hosted via llama.cpp on an M4 Pro 48GB MacBook, with the following config:

```sh
llama-server \
  -c 131072 \
  -ngl 99 \
  --slot-save-path /tmp/llama-slots \
  --flash-attn on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --jinja \
  --temp 0.6 \
  --top-p 0.95 \
  --top-k 20 \
  --min-p 0.0 \
  --presence-penalty 0.0 \
  --repeat-penalty 1.0 \
  --reasoning-budget 16384 \
  --reasoning-budget-message "Alright, I've thought enough. Let me take the next concrete step now — either a tool call or a final answer — and refine based on what I learn." \
  -np 1
```

_Note 1_: results are preliminary as only 3 independent full runs were conducted; Terminal-Bench 2.0 requires 5 independent full runs under a fixed configuration for an official score.

_Note 2_: the gap with little-coder may be partly explained by different inference configs (128K context vs 32K, Q6_K_XL vs Q4_K_M, higher thinking budget, etc.).

_Note 3_: in r1 and r3, the `code-from-image` trial was counted as non-passing because Qwen autonomously searched for the answer online after legitimately trying for a while.

_Note 4_: see the [`benchmarks/terminal_bench_2`](./benchmarks/terminal_bench_2/) dir for breakdown of results and reproduction steps.

## Agent Tools

HD Agent revamps Pi's default tools (`bash`, `read`, `write`, `edit`) so they produce consistent behaviour and output, cross-reference each other where useful, and render uniformly in the TUI. It also adds:

- **`apply_patch`** - V4A patch editing, dynamically exposed instead of `edit` for OpenAI models
- **`glob`** - file enumeration by glob pattern, sorted newest-first, respects `.gitignore`
- **`grep`** - regex search across files with context lines, multiline matching, respects `.gitignore`
- **`web_search`** - search the web via [Exa](https://exa.ai) with ranked results and snippets
- **`web_fetch`** - fetch websites as Markdown via [Jina](https://jina.ai/reader/), with browser-rendered fallback via [`Bun.WebView`](https://bun.com/docs/runtime/webview)
- **`subagent`** - delegate complex work to isolated sub-sessions with full tool access
- **`todo`** - in-session task list with a live widget in the UI footer

## Terminal UI

HD Agent also ships with quality of life improvements for the TUI:

- **ANSI-compatible themes** - `pim-light` and `pim-dark` themes which adapt to your terminal's colour scheme
- **fzf-style autocomplete** - `@path` file picker and `/command` picker with fuzzy search
- **Git-aware powerline footer** - cwd, git branch and states, context usage, model and session cost
- **TPS reporting** - per-cycle decode/prefill rate, TTFT, and cache read tokens (toggle with `/tps`)
- **Concise tool UI** - minimal one-liner title across all tool calls, `Ctrl+O` to toggle full details

## Telegram Bot

Run HD Agent as a Telegram bot with full agent capabilities in your DMs or group chats (supports threads).

### Setup

Create `~/.pim/telegram/config.json` with your bot token (from [@BotFather](https://t.me/BotFather)) and an allowlist of chat IDs the bot will respond to:

```json
{
  "token": "YOUR_TELEGRAM_BOT_TOKEN",
  "allow": [123456789, 987654321]
}
```

Then, install and run as a persistent daemon (_recommended_):

```sh
# Supports Linux (systemd) and macOS (launchd)
hd-agent --mode telegram --install

# Tear down
hd-agent --mode telegram --uninstall
```

The daemon auto-restarts on failure and supports the `/update` command for in-chat updates.

For development, run standalone with `hd-agent --mode telegram` instead.

### Commands

> [!TIP]
> Use `/commands` on your bot for all commands to show up on your Telegram UI.

| Command      | Description                                        |
| ------------ | -------------------------------------------------- |
| `/cancel`    | Cancel the current turn                            |
| `/cd`        | Show or change the working directory               |
| `/chatid`    | Show this chat's numeric ID                        |
| `/clear`     | Reset chat history and context window              |
| `/commands`  | Register all commands with Telegram                |
| `/compact`   | Compact the current session context                |
| `/effort`    | Show or change thinking effort level               |
| `/logs`      | Show or change log verbosity                       |
| `/model`     | Show or change the AI model                        |
| `/temporary` | Toggle temporary chat (fresh session each message) |
| `/update`    | Update the bot to the latest version               |
| `/usage`     | Show context window and session cost               |

### Features

- ⏰ **Scheduled tasks** - your bot can create one-time, interval, or cron-based tasks that fire automatically; ask your bot to schedule something.
- 👀 **Live progress logs** - use `/logs` to choose what you see while the agent works: final replies, tool use, intermediate text, or thinking.
- 📝 **Rich Markdown** - supports Telegram's [rich text formatting](https://telegram.org/blog/watch-apps-and-more#obscenely-rich-text-formatting-for-bots) with full markdown and LaTeX math support.
- 📎 **Rich media** - send photos, documents, videos, audio, and voice messages directly in chat; your bot can also send files back to you.
- 🧵 **Thread-specific prompts** - each chat (or thread) gets its own session and optional instructions; ask your bot to modify its instructions.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Developing

```sh
# Link locally and launch:
bun dev
```

HD Agent is registered as a project-local Pi package via `.pi/settings.json` and auto-loads when launched from within this repo. Use the built-in `/reload` command to reload after edits without restarting.
