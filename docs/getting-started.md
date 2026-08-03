# HD Agent - Hướng dẫn cài đặt và sử dụng

## Cài đặt

### Yêu cầu

- **Bun** runtime (script sẽ tự cài nếu chưa có)
- **Pi** coding agent (script sẽ tự cài nếu chưa có)

### Cài đặt bằng một lệnh

```sh
curl -fsSL https://raw.githubusercontent.com/tuong-nguyen-vn/hd-agent/main/install.sh | sh
```

Script tự động:
- Cài Bun nếu chưa có (macOS, Linux, WSL, Windows Git Bash)
- Cài Pi nếu chưa có
- Gỡ package cũ `pim-agent` nếu còn (tránh xung đột tool)
- Cài/ cập nhật HD Agent làm Pi extension
- Cài/ cập nhật launcher `hd-agent` toàn cục

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

Chọn một trong các provider có sẵn. Hai provider nội bộ chính:

| Provider | Cách lấy key |
| --- | --- |
| **Devin** | Yêu cầu admin cấp key cho tài khoản Devin |
| **HDWEBSOFT** | Dùng API key được cung cấp bởi HDWEBSOFT |

### Devin

1. Chọn account **Devin** trong `/login`.
2. Yêu cầu admin cấp API key cho tài khoản của bạn.
3. Nhập key khi được hỏi.

### HDWEBSOFT

1. Chọn **API Key** trong `/login`.
2. Chọn provider **hdwebsoft**.
3. Nhập key được cung cấp.

---

## Cấu hình cơ bản

### Theme

```
/settings
```

Chọn **Theme** → chọn **pim-dark**.

### Pi settings khuyến nghị

Thêm vào `~/.pi/agent/settings.json`:

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

HD Agent có hai subagent mặc định.

### Oracle

- **Mục đích**: AI advisor với khả năng suy luận nâng cao.
- **Khi dùng**: review code, feedback kiến trúc, tìm bug khó trải nhiều file, lập kế hoạch implement/refactor phức tạp, trả lời câu hỏi kỹ thuật cần suy luận sâu, hoặc xin ý kiến thứ hai khi agent chính bí.
- **Model**: `gpt-5.6-sol`, `gpt-5.6-luna`, `claude-opus-5`.
- **Không dùng cho**: đọc file, tìm kiếm keyword đơn giản, duyệt web, sửa code cơ bản.

### Search

- **Mục đích**: Tìm kiếm code song song, nhanh.
- **Khi dùng**: tìm file/ code theo chức năng hoặc khái niệm, chain nhiều tìm kiếm, liệt kê tất cả occurrences của một pattern.
- **Model**: `gemini-3.6-flash`, `swe-1-7`.
- **Đặc điểm**: chạy nhiều tool call song song mỗi turn, hoàn thành trong 3 turn, trả về danh sách file kèm line range.

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
