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
6. **`allowlist.ts`** — Parses + enforces the inbound `AFK_TELEGRAM_ALLOWED_CHAT_IDS`
   gate. Outbound notification routing lives in **`notify-routing.ts`** (see
   [Notification routing](#notification-routing)).
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
| `AFK_TELEGRAM_ALLOWED_CHAT_IDS`   | Yes      | Comma-separated numeric chat IDs — the **inbound gate** (who can message the bot) |
| `AFK_TELEGRAM_TAG_ONLY_CHAT_IDS`  | No       | Comma-separated chat IDs where the bot answers **only when addressed** (reply/@mention/text_mention). Fallback for `telegram.tagOnlyChats`. See [Tag-only response policy](#tag-only-response-policy) |
| `AFK_TELEGRAM_NOTIFY_MODE`        | No       | Outbound fan-out: `primary` (default — one chat), `broadcast` (every allowed chat), `custom` |
| `AFK_TELEGRAM_PRIMARY_CHAT_ID`    | No       | Default chat for outbound notifications. Defaults to the first private/DM chat in the allowlist |
| `ANTHROPIC_API_KEY` *or* `CLAUDE_CODE_OAUTH_TOKEN` | One of (or keychain) | See Auth section |
| `CLAUDE_MODEL` *or* `AFK_MODEL`   | No       | Default `opus`                          |
| `TELEGRAM_VERBOSE`                | No       | `true` to log every chat event          |
| `TELEGRAM_DATA_DIR`               | No       | Override session-store location         |

`afk telegram setup` walks you through the first two required vars.

## Notification routing

The **inbound allowlist** (`AFK_TELEGRAM_ALLOWED_CHAT_IDS`) governs who may *command*
the bot. **Outbound notifications** (daemon task/crash alerts, the `send_telegram`
tool, MCP OAuth prompts, `/review` posts, digests) are routed separately — by
default to a single **primary** chat, not fanned out to every allowed chat.

Resolution (`src/telegram/notify-routing.ts`), highest precedence first:

1. `afk.config.json` `telegram.notify` block (structured source of truth)
2. env overrides (`AFK_TELEGRAM_NOTIFY_MODE`, `AFK_TELEGRAM_PRIMARY_CHAT_ID`)
3. heuristic default: the first **positive** (private/DM) chat id in the allowlist
   — Telegram DM ids are positive, group/channel ids negative — else the first
   allowed id

```jsonc
// afk.config.json
{
  "telegram": {
    "notify": {
      "mode": "primary",                     // "primary" (default) | "broadcast" | "custom"
      "primaryChatId": 123456789,            // optional; overrides the DM heuristic
      "targets": [123456789, -1001234567890] // used only when mode === "custom"
    }
  }
}
```

- `broadcast` restores the legacy fan-out to every allowed chat.
- `custom` targets are **not** constrained to the allowlist (an announce-only
  group the bot posts to but takes no commands from is valid); Telegram's own
  bot-messaging rules gate actual delivery.
- **Behavior change:** previously every notification fanned out to all allowed
  chats. Single-chat setups are unaffected; multi-chat setups now default to the
  primary chat — set `mode: "broadcast"` (or `AFK_TELEGRAM_NOTIFY_MODE=broadcast`)
  to restore the old behavior.

## Tag-only response policy

By default the bot answers **every** non-command text/photo message in every
allowlisted chat. That's fine for a DM, but noisy in a shared group where the
bot is one participant among many. The **tag-only** policy makes the bot respond
in a configured chat **only when it is addressed** — otherwise the message is
dropped silently (no reply, no `👀` reaction, just a log line). Slash-commands
(`/help`, `/clear`, …) are always honored regardless of this policy, and any
chat **not** listed behaves exactly as before.

A message counts as *addressed to the bot* when any of these hold:

1. It **replies** to one of the bot's own messages.
2. It **@mentions** the bot's username (a Telegram `mention` entity equal to
   `@<botUsername>`, matched case-insensitively).
3. It carries a **`text_mention`** entity (used for accounts without a public
   username) whose user id is the bot's id.

For a photo, the caption and its `caption_entities` are inspected the same way,
plus the reply target.

> [!IMPORTANT]
> **You must turn Telegram privacy mode OFF for the bot**, or this policy is
> moot in groups. With privacy mode **ON** (the BotFather default), Telegram
> only delivers to the bot the messages that already address it (commands,
> replies, @mentions) — so the bot never even *sees* the ambient chatter the
> policy is meant to ignore, and adding a chat to `tagOnlyChats` changes
> nothing. Disable it once per bot:
> **@BotFather → `/mybots` → your bot → Bot Settings → Group Privacy → Turn off**
> (equivalently `/setprivacy` → select the bot → **Disable**). agent-afk does
> **not** enforce or change this setting for you — it only reminds you at
> startup when `tagOnlyChats` is non-empty.

Configure it via `afk.config.json` (authoritative) or the
`AFK_TELEGRAM_TAG_ONLY_CHAT_IDS` env var (fallback — the config value wins when
both are set):

```jsonc
// afk.config.json
{
  "telegram": {
    // Chats where the bot only answers when addressed. Others are unaffected.
    "tagOnlyChats": [-1001234567890, -1009876543210]
  }
}
```

```bash
# Env fallback (comma-separated; negative = group/channel id). Config wins.
AFK_TELEGRAM_TAG_ONLY_CHAT_IDS=-1001234567890,-1009876543210
```

Because this controls **which chats the bot will respond in**, it is a
human-tier config key (like the allowlist and `telegram.notify.*`): the
`afk config` CLI can manage it, but the agent's own `config_set` tool cannot.
The env twin `AFK_TELEGRAM_TAG_ONLY_CHAT_IDS` is likewise protected.

## Testing

```bash
# All telegram unit tests
pnpm test tests/telegram

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

## Bidirectional AFK — daemon role

When a REPL session runs `/afk on`, the daemon becomes the **phone-side half** of a
bidirectional elicitation channel. The two processes communicate **only through the
per-session ledger file** (`~/.afk/state/sessions/<id>/events.jsonl`) — no sockets,
no shared memory, no second Telegram poller.

### Auto-subscribe

Every 30 seconds (configurable via `TelegramBot.AUTO_SUBSCRIBE_INTERVAL_MS`), the bot
reads all presence files and automatically starts watching any session where
`surface === 'cli' && afk === true`. No manual `/watch` is needed — stepping away with
`/afk on` is enough.

### Rendering elicitations to the phone

When the daemon's `SessionWatchManager._run` tail sees an `elicitation` record, it
invokes `makeTelegramElicitationHandler` (from `elicitation-handler.ts`) to render the
question interactively:

- **`text` / open-ended questions** — sends a plain message and waits for the next
  text reply from the operator.
- **`choice` / `confirm` questions** — renders Telegram inline-keyboard buttons; the
  operator taps an option.

The message-handler bypasses the `state === 'idle'` guard for ledger-originated
elicitations via `ledgerOriginatedPendingChats` (a `Set<number>` in
`handlers/message.ts`) so phone replies are delivered even though no `AgentSession` is
running inside the daemon for this session.

### Signed write-back

After the operator answers, the daemon:

1. Reads the per-session HMAC key from `~/.afk/state/sessions/<id>/session.key`
   (written 0600 by the REPL on `/afk on`).
2. Signs the response with `signElicitationResponse` (HMAC-SHA256 over
   `recordKind‖sessionId‖reqId‖stableStringify(result)`).
3. Appends a signed `elicitation_response` record to the ledger.

The REPL verifies the HMAC before acting on the response. An unverified or stray write
is silently ignored — it cannot drive the agent.

### Remote abort

`/abort` (sent to the bot while watching a session):

1. Daemon looks up the currently-watched session via `watchManager.getWatched(chatId)`.
2. Signs a `abort_request` record (HMAC over `recordKind‖sessionId‖nonce`).
3. Appends it to the ledger.

The REPL's `makeAbortWatcher` tail (running since `/afk on`) verifies the HMAC and
fires the `AbortGraph` — aborting the session cleanly. An unsigned or cross-session
abort record is ignored.

### Security boundary

The HMAC layer guards against **accidental cross-session bleed** and **stray writers**.
It is NOT a defence against a malicious same-user process (which can read the 0600 key
and already has the user's OS privileges). Telegram ingress remains gated by the
existing `AFK_TELEGRAM_ALLOWED_CHAT_IDS` allowlist. The AFK safety gate
(`afk-mode-gate.ts`) is **non-overridable** — a remote reply is an input to the
agent's reasoning, never a gate bypass.

For the full design, threat model, flow diagram, five hard invariants, and known
limitations, see [`docs/afk-remote-control.md`](../../docs/afk-remote-control.md).

---

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
