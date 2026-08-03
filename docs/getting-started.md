# HD Agent - Getting Started Guide

## Installation

### Prerequisites

- **Bun** runtime (the installer will install it if missing)
- **Pi** coding agent (the installer will install it if missing)

### One-command install

```sh
curl -fsSL https://raw.githubusercontent.com/tuong-nguyen-vn/hd-agent/main/install.sh | sh
```

The installer automatically:
- Installs Bun if missing (macOS, Linux, WSL, Windows Git Bash)
- Installs Pi if missing
- Removes the legacy `pim-agent` package if present (avoids tool conflicts)
- Installs or updates HD Agent as a Pi extension
- Installs or updates the `hd-agent` global launcher

### Manual install

```sh
curl -fsSL https://pi.dev/install.sh | sh
pi install git:github.com/tuong-nguyen-vn/hd-agent
bun install -g github:tuong-nguyen-vn/hd-agent
```

### Launch

```sh
hd-agent
```

---

## Provider and API Key Setup

### Select a provider

In the TUI, run:

```
/login
```

Choose from the available providers. Two main internal providers:

| Provider | How to get a key |
| --- | --- |
| **Devin** | Request an API key from your admin for your Devin account |
| **HDWEBSOFT** | Use the API key provided by HDWEBSOFT |

### Devin

1. Select the **Devin** account in `/login`.
2. Request an API key from your admin.
3. Enter the key when prompted.

### HDWEBSOFT

1. Select **API Key** in `/login`.
2. Select the **hdwebsoft** provider.
3. Enter the provided key.

---

## Basic Configuration

### Theme

```
/settings
```

Select **Theme** → select **pim-dark**.

### Recommended Pi settings

Add to `~/.pi/agent/settings.json`:

```json
{
  "quietStartup": true,
  "editorPaddingX": 1,
  "markdown": {
    "codeBlockIndent": ""
  }
}
```

### HD Agent settings

File: `~/.pim/settings.json`

```json
{
  "tps": {
    "enabled": false
  },
  "powerline": {
    "enabled": true
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

---

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+T` | Toggle Thinking on/ off |
| `Shift+Tab` | Switch Thinking mode |
| `Ctrl+P` | Quick-switch model |
| `Ctrl+O` | Toggle tool call details |
| `Esc` | Cancel autocomplete / abort streaming |
| `Ctrl+C` | Clear editor (first) / exit (second) |

### Slash commands

| Command | Action |
| --- | --- |
| `/settings` | Open settings menu |
| `/scope <model>` | Select frequently used models |
| `/tps` | Toggle inference speed reporting |
| `/hotkeys` | Show all keyboard shortcuts |

---

## Subagents

HD Agent ships with two built-in subagents.

### Oracle

- **Purpose**: AI advisor with advanced reasoning capabilities.
- **When to use**: code reviews, architecture feedback, finding difficult bugs across many files, planning complex implementations or refactors, answering deep technical questions, or getting a second opinion when the main agent is stuck.
- **Models**: `gpt-5.6-sol`, `gpt-5.6-luna`, `claude-opus-5`.
- **Not for**: file reads, simple keyword searches, web browsing, basic code edits.

### Search

- **Purpose**: Fast, parallel code search.
- **When to use**: finding files and code by functionality or concept, chaining multiple searches, locating all occurrences of a pattern across the codebase.
- **Models**: `gemini-3.6-flash`, `swe-1-7`.
- **Characteristics**: runs multiple tool calls in parallel per turn, completes within 3 turns, returns a list of files with line ranges.

### Custom subagents

Place markdown files in:

```
~/.pi/agent/agents/      # user-level
.pi/agents/              # project-level (overrides user-level)
```

File format (see `src/extensions/subagent/bundled-agents/` for examples):

```markdown
---
name: MyAgent
description: Short description of what this agent does.
tools: grep, glob, read
model: gpt-5.6-sol
---

You are MyAgent — ...
```

Project-level agents override user-level agents, which in turn override bundled defaults (matching is case-insensitive).
