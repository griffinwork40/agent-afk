# Telegram Bot Integration

Telegram bot interface for agent-afk. Each Telegram chat maps to one
`AgentSession`; responses stream back to Telegram in real time with
automatic chunking past the 4096-char limit.

## Quick start

```bash
# One-time interactive setup: validates the bot token and auto-discovers
# your chat ID by watching getUpdates while you DM the bot.
afk telegram setup

# Start the bot as a background daemon. PID + logs go under ~/.afk/.
afk telegram start

# Lifecycle
afk telegram status
afk telegram stop
afk telegram restart
afk telegram logs -f
```

## Architecture

### Components

1. **`bot.ts`** — Main bot class (Telegraf framework). Owns the lifecycle,
   stream pump, and error recovery.
2. **`handlers/`** — Per-update handlers (message, command).
3. **`session-manager.ts`** — Maps Telegram chat IDs → `AgentSession`
   instances. Handles creation, reset, model switching, and disk
   persistence.
4. **`streaming.ts`** — Long-message chunking + edit-throttling under
   Telegram's 10-edit-per-minute limit.
5. **`formatter.ts`** — Message formatting, command listing, markdown
   escaping.
6. **`allowlist.ts`** — Parses + enforces `AFK_TELEGRAM_ALLOWED_CHAT_IDS`.
7. **`manager.ts`** — Background-process lifecycle (spawn detached, PID
   file, SIGTERM→SIGKILL, status). State lives under
   `~/.afk/state/telegram/` and `~/.afk/logs/telegram.log`.
8. **`setup-wizard.ts`** — Interactive setup that validates the bot token
   via `getMe` and discovers the user's chat ID via `getUpdates`. Writes
   to `~/.afk/config/afk.env` via the same atomic `upsertEnvVar` helper
   the credential wizard uses.

### Auth

The Telegram entrypoint resolves Claude credentials through the **same**
path the CLI uses (`loadCredential` in `src/cli/config.ts`):

1. `ANTHROPIC_API_KEY` env var
2. `CLAUDE_CODE_OAUTH_TOKEN` env var
3. macOS Keychain (`Claude Code-credentials`, populated by `claude
   setup-token` or Claude Code sign-in). On Linux, the same data lives at
   `~/.claude/.credentials.json`.

Token shape (`sk-ant-oat01-*` vs. `sk-ant-api*`) is detected by
`detectAuthMode` in the `anthropic-direct` provider; OAuth tokens route to
Bearer auth with auto-refresh on 401 (handled by the provider's
`tokenRefresher` closure, deduplicated across concurrent requests).

The bot, daemon, interactive REPL, and chat all consume this stack — there
is no Telegram-specific auth path.

### Config locations

| What                          | Where                                  |
| ----------------------------- | -------------------------------------- |
| Bot token + allowlist + model | `~/.afk/config/afk.env`                |
| Anthropic credential          | macOS Keychain / `~/.claude/.credentials.json` (auto) |
| Per-chat session state        | `~/.afk/state/telegram/sessions/`*     |
| PID file                      | `~/.afk/state/telegram/bot.pid`        |
| Log file                      | `~/.afk/logs/telegram.log`             |

\*Override with `TELEGRAM_DATA_DIR`.

A project-scope `.env` in the repo root still works for per-repo
overrides; user-scope `~/.afk/config/afk.env` is loaded with `override:
false` so the project copy wins on conflict. Both files are loaded for the
Telegram entry now — historically only the project copy was, which is
what caused the bot to ignore credentials stashed by `afk login`.

## Available commands (Telegram)

Aligned with the Agent SDK's slash command surface:

- `/start` — Welcome + command list
- `/help` — Command list (includes SDK-native slash commands when the
  session was created with `settingSources`)
- `/clear` — Clear conversation history (SDK `/clear`)
- `/compact` — Compact conversation history (summarize older messages)
- `/model [opus|sonnet|haiku|...]` — Switch model
- `/cd [path]` — Show or change the session working directory
- `/name [name]` — Show or set this session's name so the conversation can be
  resumed by name from the CLI (`afk i --resume <name>`) instead of a UUID

## Required environment

| Variable                          | Required | Notes                                   |
| --------------------------------- | -------- | --------------------------------------- |
| `TELEGRAM_BOT_TOKEN`              | Yes      | From [@BotFather](https://t.me/BotFather) |
| `AFK_TELEGRAM_ALLOWED_CHAT_IDS`   | Yes      | Comma-separated numeric chat IDs (gates who can message the bot) |
| `ANTHROPIC_API_KEY` *or* `CLAUDE_CODE_OAUTH_TOKEN` | One of (or keychain) | See Auth section |
| `CLAUDE_MODEL` *or* `AFK_MODEL`   | No       | Default `opus`                          |
| `TELEGRAM_VERBOSE`                | No       | `true` to log every chat event          |
| `TELEGRAM_DATA_DIR`               | No       | Override session-store location         |

`afk telegram setup` walks you through the first three.

## Testing

```bash
# All telegram unit tests
pnpm test -- tests/telegram

# Integration tests
pnpm test:integration
```

Covered:

- `formatter.test.ts` — Message splitting + markdown escaping
- `session-manager.test.ts` — Lifecycle, model switching, persistence
- `bot.test.ts` — Command handling, message processing, streaming, error
  handling
- `allowlist.test.ts` — Chat ID parsing and enforcement
- `streaming.test.ts` — Long-message chunking and rate-limiting
- `manager.test.ts` — PID lifecycle, stale-PID cleanup, `parseEtime`
- `setup-wizard.test.ts` — `getMe` validation, `getUpdates` parsing,
  poll-with-early-stop

## Design decisions

1. **One session per chat.** Simpler than per-user; works for both
   private and group chats.
2. **Streaming updates.** Long responses surface progress; bounded by
   Telegram's 10-edit/min limit (`streaming.ts` enforces).
3. **File-based persistence.** No DB; JSON sidecars per chat. Easy
   backup/restore.
4. **User-scope config.** Bot tokens, allowlists, and PID/log state live
   under `~/.afk/`, not the project tree. Multiple repos share one bot
   without copying secrets around.
5. **OAuth-first auth.** When a Claude Code OAuth token exists, the
   provider uses Bearer auth with auto-refresh on 401, writing the
   refreshed token back to the keychain. No periodic refresh interval
   needed.
