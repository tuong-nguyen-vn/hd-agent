# HD Agent - Hướng dẫn cài đặt và sử dụng (Tiếng Việt)

## Cài đặt

### Cài bằng một lệnh

```sh
curl -fsSL https://raw.githubusercontent.com/tuong-nguyen-vn/hd-agent/main/install.sh | sh
```

Script tự động:
- Cài Bun nếu chưa có (macOS, Linux, WSL, Windows Git Bash)
- Cài Pi nếu chưa có
- Cài hoặc cập nhật HD Agent làm Pi extension
- Cài hoặc cập nhật launcher `hd-agent` toàn cục

### Cài thủ công

```sh
curl -fsSL https://pi.dev/install.sh | sh
pi install git:github.com/tuong-nguyen-vn/hd-agent
bun install -g github:tuong-nguyen-vn/hd-agent
```

### Khởi động

```sh
hd-agent
```

---

## Cấu hình Provider và API Key

### Chọn provider

Trong TUI, gõ lệnh:

```
/login
```

Bạn sẽ thấy hai phương thức xác thực:

```
Select authentication method:

 → Sign in with an account
   Sign in with an API key

 ↑↓ navigate  enter select  escape/ctrl+c cancel
```

- **Sign in with an account** — đăng nhập OAuth cho các provider như Devin, GitHub Copilot, OpenRouter, v.v.
- **Sign in with an API key** — nhập API key thủ công cho các provider như HDWEBSOFT, OpenAI, Anthropic, v.v.

Dùng `↑`/`↓` để di chuyển, `Enter` để chọn, `Esc` hoặc `Ctrl+C` để hủy.

### Devin (Sign in with an account)

1. Gõ `/login`.
2. Chọn **Sign in with an account**.
3. Chọn **Devin** từ danh sách provider.
4. Bạn sẽ được chuyển đến luồng OAuth của Devin. Nếu chưa có API key, yêu cầu admin cấp key.
5. Hoàn tất đăng nhập. Thông tin xác thực được lưu tự động.

### HDWEBSOFT (Sign in with an API key)

1. Gõ `/login`.
2. Chọn **Sign in with an API key**.
3. Chọn **hdwebsoft** từ danh sách provider.
4. Nhập API key được HDWEBSOFT cung cấp khi được hỏi.
5. Key được lưu tự động.

### Kiểm tra đăng nhập

Sau khi đăng nhập, kiểm tra provider đang hoạt động:

```
/model
```

Lệnh này hiển thị model và provider hiện tại. Bạn có thể switch model bằng `Ctrl+P` hoặc `/scope`.

---

## Cấu hình cơ bản

### Theme

```
/settings
```

Chọn **Theme** → chọn **pim-dark** (hoặc theme nào bạn thích).

### HD Agent settings

File: `~/.pim/settings.json`

```json
{
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
    "model": "gemini-3.7-flash"
  },
  "agents": {
    "Oracle": "gpt-5.6-sol,claude-opus-5,gpt-5.6-luna,grok-4.5-medium",
    "Search": "gemini-3.7-flash,deepseek-v4-flash"
  }
}
```

#### API key cho web search (tùy chọn)

Web tools của HD Agent dùng [Exa](https://exa.ai) để tìm kiếm web và [Jina](https://jina.ai/reader/) để tải trang web dạng Markdown. Cả hai đều hoạt động không cần API key nhưng có giới hạn rate. Nếu dùng nhiều hơn, thêm key của bạn:

```json
{
  "exa": {
    "apiKey": "your-exa-api-key"
  },
  "jina": {
    "apiKey": "your-jina-api-key"
  }
}
```

Biến môi trường sẽ override `settings.json` khi có:

```sh
EXA_API_KEY='your-key' JINA_API_KEY='your-key' hd-agent
```

#### Painter (tạo ảnh)

Thiết lập model dùng để tạo ảnh. Model phải tồn tại trong `~/.pi/agent/models.json` với provider dùng API `openai-completions`.

```json
{
  "painter": {
    "model": "gpt-image-2"
  }
}
```

#### ViewMedia (phân tích ảnh)

Thiết lập model dùng để xem và phân tích ảnh. Model phải tồn tại trong `~/.pi/agent/models.json`.

```json
{
  "viewMedia": {
    "model": "gemini-3.7-flash"
  }
}
```

#### Model cho subagent

Override model dùng cho từng subagent. Giá trị là danh sách model ID cách nhau bằng dấu phẩy (thử theo thứ tự với fallback):

```json
{
  "agents": {
    "Oracle": "gpt-5.6-sol,claude-opus-5,gpt-5.6-luna,grok-4.5-medium",
    "Search": "gemini-3.7-flash,deepseek-v4-flash"
  }
}
```

Nếu subagent không được liệt kê ở đây, nó sẽ dùng model mặc định từ bundled.

---

## Phím tắt

| Phím | Chức năng |
| --- | --- |
| `Ctrl+T` | Bật/ tắt Thinking |
| `Shift+Tab` | Switch Thinking mode |
| `Ctrl+P` | Switch nhanh model |
| `Ctrl+O` | Toggle chi tiết tool call |
| `Esc` | Hủy autocomplete / dừng streaming |
| `Ctrl+C` | Xóa editor (lần 1) / thoát (lần 2) |

### Lệnh slash

| Lệnh | Chức năng |
| --- | --- |
| `/settings` | Mở menu cài đặt |
| `/scope <model>` | Chọn các model hay sử dụng |
| `/tps` | Bật/ tắt báo cáo tốc độ inference |
| `/hotkeys` | Xem tất cả phím tắt |

---

## Subagent

HD Agent có sẵn hai subagent mặc định.

### Oracle

- **Mục đích**: AI advisor với khả năng suy luận nâng cao — không phải model mạnh hơn cho việc code hàng ngày, mà là "ý kiến thứ hai" cho những việc cần suy luận sâu.
- **Khi dùng**: review code, feedback kiến trúc, tìm bug khó trải nhiều file, lập kế hoạch implement/refactor phức tạp, trả lời câu hỏi kỹ thuật cần suy luận sâu, hoặc xin ý kiến thứ hai khi agent chính bí.
- **Model**: `gpt-5.6-sol`, `claude-opus-5`, `deepseek-v4-pro`, `gpt-5.6-luna`, `grok-4.5-medium` — thử lần lượt, model nào phản hồi được thì dùng.
- **Không dùng cho**: đọc file, tìm kiếm keyword đơn giản, duyệt web, sửa code cơ bản.
- **Luôn cần bạn duyệt trước**: agent chính **không tự ý** gọi Oracle. Một lượt tư vấn tốn 5-10 phút và tiền, nên agent sẽ hỏi lại trước ("bạn có muốn dùng Oracle không?") và chỉ dispatch sau khi bạn đồng ý — trừ khi chính bạn đã gõ thẳng "dùng Oracle" trong yêu cầu, lúc đó nó bỏ qua bước hỏi và làm luôn.
- **Cách giao việc**: Oracle khởi động với context trắng, nên agent chính thu thập context trước (tự làm hoặc qua Search subagent) rồi gửi brief tự chứa kèm trích dẫn code, đánh dấu mỗi finding là **VERIFIED** (đã tự đọc) hay **HYPOTHESIS** (Search báo, chưa kiểm) để Oracle không mất công đi xác minh lại phát hiện sai. File nguồn liên quan truyền qua `context_paths` của tool subagent (`"path"` hoặc `"path:start-end"`); nội dung được inline vào prompt kèm số dòng. **Ngoài ra, bất kỳ file nào brief trích dẫn dạng `path:line` cũng tự động được đọc và đính kèm** — kể cả khi dùng đường dẫn rút gọn (ví dụ `pipeline.py:120` thay vì đường dẫn đầy đủ) — nên agent chính không cần liệt kê lại mọi thứ trong `context_paths`. Giới hạn cứng: 64KB mỗi entry, 256KB tổng — vượt là call bị từ chối kèm lỗi để agent chính gửi lại với line range hẹp hơn.

### Search

- **Mục đích**: Tìm kiếm code song song, nhanh.
- **Khi dùng**: tìm file/ code theo chức năng hoặc khái niệm, chain nhiều tìm kiếm, liệt kê tất cả occurrences của một pattern.
- **Model**: `gemini-3.7-flash`, `deepseek-v4-flash-free`, `deepseek-v4-flash`.
- **Đặc điểm**: chạy nhiều tool call song song mỗi turn, cố gắng hoàn thành trong 3 turn, trả về danh sách file kèm line range. Đây là agent định vị (file nào, dòng nào) — nếu cần Search phân tích sâu hơn, hãy tự kiểm tra lại phát hiện của nó trước khi coi là sự thật.

### Custom subagent

Đặt file markdown vào:

```
~/.pi/agent/agents/      # user-level
.pi/agents/              # project-level (override user-level)
```

Format file (xem `src/extensions/subagent/bundled-agents/` để tham khảo):

```markdown
---
name: MyAgent
description: Mô tả ngắn về tính năng.
tools: grep, glob, read
model: gpt-5.6-sol
---

You are MyAgent — ...
```

Project-level override user-level, user-level override bundled (matching case-insensitive).

---

# English version below / Phiên bản tiếng Anh bên dưới

---

# HD Agent - Getting Started Guide

## Installation

### One-command install

```sh
curl -fsSL https://raw.githubusercontent.com/tuong-nguyen-vn/hd-agent/main/install.sh | sh
```

The installer automatically:
- Installs Bun if missing (macOS, Linux, WSL, Windows Git Bash)
- Installs Pi if missing
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

You will see two authentication methods:

```
Select authentication method:

 → Sign in with an account
   Sign in with an API key

 ↑↓ navigate  enter select  escape/ctrl+c cancel
```

- **Sign in with an account** — OAuth login for providers like Devin, GitHub Copilot, OpenRouter, etc.
- **Sign in with an API key** — manual API key entry for providers like HDWEBSOFT, OpenAI, Anthropic, etc.

Use `↑`/`↓` to navigate, `Enter` to select, `Esc` or `Ctrl+C` to cancel.

### Devin (Sign in with an account)

1. Run `/login`.
2. Select **Sign in with an account**.
3. Select **Devin** from the provider list.
4. You will be redirected to Devin's OAuth flow. If you don't have an API key yet, request one from your admin.
5. Complete the sign-in. The credential is saved automatically.

### HDWEBSOFT (Sign in with an API key)

1. Run `/login`.
2. Select **Sign in with an API key**.
3. Select **hdwebsoft** from the provider list.
4. Enter the API key provided by HDWEBSOFT when prompted.
5. The key is saved automatically.

### Verify login

After login, check that the provider is active:

```
/model
```

This shows the current model and provider. You can switch models with `Ctrl+P` or `/scope`.

---

## Basic Configuration

### Theme

```
/settings
```

Select **Theme** → select **pim-dark** (or any theme you prefer).

### HD Agent settings

File: `~/.pim/settings.json`

```json
{
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
    "model": "gemini-3.7-flash"
  },
  "agents": {
    "Oracle": "gpt-5.6-sol,claude-opus-5,gpt-5.6-luna,grok-4.5-medium",
    "Search": "gemini-3.7-flash,deepseek-v4-flash"
  }
}
```

#### Web search API keys (optional)

HD Agent's web tools use [Exa](https://exa.ai) for web search and [Jina](https://jina.ai/reader/) for fetching websites as Markdown. Both work without API keys but are rate-limited. For heavier usage, add your keys:

```json
{
  "exa": {
    "apiKey": "your-exa-api-key"
  },
  "jina": {
    "apiKey": "your-jina-api-key"
  }
}
```

Environment variables override `settings.json` when present:

```sh
EXA_API_KEY='your-key' JINA_API_KEY='your-key' hd-agent
```

#### Painter (image generation)

Set the model used for image generation. The model must exist in `~/.pi/agent/models.json` with a provider that uses `openai-completions` API.

```json
{
  "painter": {
    "model": "gpt-image-2"
  }
}
```

#### ViewMedia (image analysis)

Set the model used for viewing and analyzing images. The model must exist in `~/.pi/agent/models.json`.

```json
{
  "viewMedia": {
    "model": "gemini-3.7-flash"
  }
}
```

#### Subagent models

Override the model used by each subagent. Values are comma-separated model IDs (tried in order with fallback):

```json
{
  "agents": {
    "Oracle": "gpt-5.6-sol,claude-opus-5,gpt-5.6-luna,grok-4.5-medium",
    "Search": "gemini-3.7-flash,deepseek-v4-flash"
  }
}
```

If a subagent is not listed here, it falls back to its bundled default model.

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

- **Purpose**: AI advisor with advanced reasoning capabilities — not a stronger model for everyday coding, but a second opinion for work that genuinely needs deep reasoning.
- **When to use**: code reviews, architecture feedback, finding difficult bugs across many files, planning complex implementations or refactors, answering deep technical questions, or getting a second opinion when the main agent is stuck.
- **Models**: `gpt-5.6-sol`, `claude-opus-5`, `deepseek-v4-pro`, `gpt-5.6-luna`, `grok-4.5-medium` — tried in order, first one that responds wins.
- **Not for**: file reads, simple keyword searches, web browsing, basic code edits.
- **Always asks first**: the main agent never dispatches Oracle on its own initiative. A consultation costs 5-10 minutes and real money, so it asks you first ("want me to consult Oracle?") and only dispatches once you agree — unless you already asked for Oracle by name in your request, in which case it skips the question and proceeds directly.
- **How to brief it**: Oracle starts with a fresh context, so the main agent gathers context first (itself or via Search subagents) and sends a self-contained brief with quoted evidence, marking each finding **VERIFIED** (read directly) or **HYPOTHESIS** (reported by Search, unchecked) so Oracle doesn't waste time re-verifying a false lead. Supporting files go in the subagent tool's `context_paths` (`"path"` or `"path:start-end"`); their contents are inlined into the prompt with line numbers. **Any file the brief cites as `path:line` is also read and attached automatically** — even a shortened path (e.g. `pipeline.py:120` instead of the full path) — so the main agent doesn't need to re-list everything in `context_paths`. Hard caps: 64KB per entry, 256KB total — oversized calls are rejected with an error so the main agent retries with narrower line ranges.

### Search

- **Purpose**: Fast, parallel code search.
- **When to use**: finding files and code by functionality or concept, chaining multiple searches, locating all occurrences of a pattern across the codebase.
- **Models**: `gemini-3.7-flash`, `deepseek-v4-flash-free`, `deepseek-v4-flash`.
- **Characteristics**: runs multiple tool calls in parallel per turn, aims to complete within 3 turns, returns a list of files with line ranges. This is a locator agent (which file, which line) — for anything that needs deeper judgment, verify its findings yourself before treating them as fact.

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
