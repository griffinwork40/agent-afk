# Agent AFK

> Run coding agents while you’re AFK.
>
> Start a run in your terminal, walk away, and get pinged when Agent AFK finishes or needs you. Every step is saved as a readable trace, so you stay in control before anything ships.

[![npm version](https://img.shields.io/npm/v/agent-afk.svg)](https://www.npmjs.com/package/agent-afk)
[![Node](https://img.shields.io/node/v/agent-afk.svg)](https://nodejs.org/)

## Install

```bash
npm install -g agent-afk
```

Requires Node ≥ 22.

Smoke test:

```bash
afk --version    # confirm the install (works before login)
afk doctor       # environment self-check
afk login        # save an Anthropic API key or OAuth token
afk chat "hello"
```

## What you can do with it

- **Chat from your terminal** — `afk chat "..."` for one-shot, `afk` for a REPL with full tool access (Bash, file ops, web fetch, grep/glob, subagents).
- **Hand long work off to a daemon** — `afk daemon` runs headless. Pair it with `send_telegram` and you get pings on your phone when work lands in a terminal state.
- **Read the trace** — every run writes an append-only record of what the agent did. `afk trace show` prints it back as a human-readable receipt — tool calls, gate decisions, subagent lifecycles, cost — so you can audit a run without reaching for `jq`.
- **Message Claude from Telegram** — `afk telegram setup` walks you through bot token + allowlist. After that you have a private chat surface backed by the same session manager as the REPL.
- **Built-in orchestrators** — `/mint`, `/diagnose`, `/spec`, `/research`, `/ship`, `/review` dispatch subagent waves. `/mint` takes a feature idea and runs spec → research → plan → parallelize → build → verify → ship. `/diagnose` forks parallel root-cause hypotheses for failing tests and bugs.

> **Agent AFK Pro:** Autonomous skill-generation (`/forge`) and the calibrated skill-qualification rubric (`/qualify`) are reserved for Agent AFK Pro and are not part of the open-source build.
- **Cross-session memory** — Claude remembers preferences, decisions, and procedures across runs. Backed by SQLite at `~/.afk/agent-framework/memory/` plus a `HOT.md` that injects into every future session's system prompt.
- **Background tasks** — Ctrl+B in the REPL detaches the current turn into a tracked task; `/tasks` lists them, `/attach <id>` re-attaches.

## Four surfaces, one session manager

| Command | Surface |
|---|---|
| `afk chat "..."` | One-shot (fire & forget) turn — pipe-friendly, scripts well |
| `afk` (alias of `afk interactive`) | REPL with slash commands, streaming, plan mode, image paste |
| `afk daemon` | Long-running headless agent, cron-friendly |
| `afk telegram start` | Telegram bot — same tools, same memory, on your phone |

## Configuration

`agent-afk` keeps all of its state under **`~/.afk/`** — sessions, plugins, memory, logs, settings. Nothing is shared with `~/.claude/`. You can delete `~/.claude` entirely and `afk` still runs.

**Local-first, no phone-home.** There is no analytics or remote telemetry — Agent AFK never sends your prompts, code, or usage anywhere except directly to the model provider you configure. What telemetry exists is local JSONL under `~/.afk/` that you can read or delete.

Optional, in order of usefulness:

```bash
# Pick a model — opus | sonnet | haiku | fable (Anthropic) or codex (OpenAI)
AFK_MODEL=sonnet

# Enable the Telegram bot + send_telegram tool
TELEGRAM_BOT_TOKEN=1234567890:ABC...
AFK_TELEGRAM_ALLOWED_CHAT_IDS=12345678

# Per-task safety rails
AFK_MAX_BUDGET_USD=5.00
```

**Project-scoped system prompt.** Drop an `AFK.md` at your project root and `afk` appends it to its built-in framework prompt whenever you run from that directory — your instructions layer on top of the base, they don't replace it. No frontmatter needed.

**Check what resolved.** `afk config` dumps the live configuration. `afk doctor` validates keys, paths, and provider connectivity.

## Models

Default is `sonnet`. Override per-call with `--model`:

```bash
afk chat "explain this stack trace" --model opus
afk i --model haiku
afk chat "refactor this" --model codex
```

| Model | Best for |
|---|---|
| `fable` | Most capable — Claude Fable 5 (Mythos-class), hardest reasoning + long-horizon agentic work (1M context) |
| `opus` | Complex reasoning, multi-step planning, long contexts |
| `sonnet` | Day-to-day default — balanced speed and capability |
| `haiku` | Fast, cheap, meh... |

## Useful commands

```bash
afk status               # connection, model, bypass-mode state
afk doctor               # environment self-check
afk config               # dump resolved config
afk plugin list          # installed plugins under ~/.afk/plugins/
afk completion zsh       # shell completion (also: bash, fish)
afk --help               # full command tree
```

Aliases: `afk c` → `chat`, `afk i` → `interactive`, `afk s` → `status`.

## A note on permissions

`afk` runs with **full permissions** by default: no per-tool prompts. Claude can run bash, read and write files, fetch URLs, and call MCP servers without asking each time. This is intentional — `afk` is built for unattended work, where a permission prompt with no human in front of it is just a wedged session.

Use `afk` on a machine and account you trust. Override per-session with `--permission-mode` if you want stricter behavior.

## Troubleshooting

**`invalid x-api-key` / `ANTHROPIC_API_KEY not found`** — run `afk doctor`. Confirm the key is set in your shell or in `~/.afk/config/afk.env`.

**`Cannot send message: session is closed`** — the session timed out or was closed. Start a new one (`afk i` or a fresh `afk chat`).

**`Maximum turns exceeded`** — safety rail tripped. Bump it with `--max-turns 50` or higher.

**Hit the budget cap** — raise `AFK_MAX_BUDGET_USD` or unset it for the session.

**Telegram bot won't start** — `afk telegram status` then `afk telegram logs`. Most common cause: missing `AFK_TELEGRAM_ALLOWED_CHAT_IDS` after token setup.

## Changelog

Recent releases at [`CHANGELOG.md`](CHANGELOG.md), also viewable in-REPL via `/changelog`.

## License

Agent AFK is **open core**, licensed under **[Apache-2.0](LICENSE)** (SPDX: `Apache-2.0`).
Use it, modify it, fork it, embed it in commercial or closed-source products — the
standard Apache conditions apply (keep the license and [`NOTICE`](NOTICE), note
significant changes, and don't use the "Agent AFK" name or marks to imply
endorsement). No copyleft, no CLA.

**Pro & Team add-ons** (premium skill packs, team features, priority support) are
separate commercial products under their own terms — see [`LICENSING.md`](LICENSING.md).
The core harness is, and will stay, free and open.

Contributions are accepted under the [DCO](https://developercertificate.org/)
(`git commit -s`). "Agent AFK" is a trademark of Griffin Long. © Griffin Long.
