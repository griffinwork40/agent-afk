# Agent AFK

> **Claude Code decides how the agent behaves. Agent AFK lets you edit the rules.**

**Agent AFK** is an open-source coding-agent harness you can actually change. Run long coding tasks while you're away, use any model, and edit the rules that decide what the agent can touch, when it stops, and how it proves the work.

> Agent AFK isn't "smarter than Claude Code." It's *yours* in a way Claude Code can't be.

[![npm version](https://img.shields.io/npm/v/agent-afk.svg)](https://www.npmjs.com/package/agent-afk)
[![CI](https://github.com/griffinwork40/agent-afk/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinwork40/agent-afk/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/agent-afk.svg)](https://nodejs.org/)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/griffinwork40/agent-afk?style=social)](https://github.com/griffinwork40/agent-afk/stargazers)

<!-- DEMO GIF GOES HERE ▸ drop a 20–30s screen recording of one autonomous AFK run (e.g. kick off `afk daemon` / `afk mint "..."`, walk away, get the Telegram ping, come back done). Drag-and-drop the file into a GitHub issue/PR to host it on GitHub's CDN, then paste the URL as ![demo](URL) right here. This is the single biggest star-conversion lever — keep it above the fold. -->

> ⭐ **Like the idea of an agent loop you fully own? [Star the repo](https://github.com/griffinwork40/agent-afk/stargazers)** — it's the fastest way to help other people find it.

## Claude Code vs. Agent AFK

| | Claude Code | Agent AFK |
|---|---|---|
| Harness | Closed binary | Apache-2.0, editable |
| The loop | You configure *around* it | You edit *the loop* |
| Behavior | Mostly fixed | Prompts, gates, routing, skills are code |
| Result | A great default agent | An agent system you own |

The model isn't the product — the loop is. Agent AFK hands you the loop as code: prompts, gates, routing, skills, traces, providers, terminal states. Edit any of them.

## Install

```bash
npm install -g agent-afk
```

Requires Node ≥ 22.

Smoke test:

```bash
afk --version    # confirm the install (works before login)
afk doctor       # environment self-check
afk chat "hello"
```

**Already using Claude Code or Codex?** Run `afk migrate` — it imports your existing plugins, skills, and MCP servers. It doesn't copy files; it live-reads the source tool's dirs, so anything you install there keeps showing up in AFK with no re-run.

## What you can do with it

- **Chat from your terminal** — `afk chat "..."` for one-shot, `afk` for a REPL with full tool access (Bash, file ops, web fetch, grep/glob, subagents).
- **Hand long work off to a daemon** — `afk daemon` runs headless. Pair it with `send_telegram` and you get pings on your phone when work lands in a terminal state.
- **Read the trace** — every run writes an append-only record of what the agent did. `afk trace show` prints it back as a human-readable receipt — tool calls, gate decisions, subagent lifecycles, cost — so you can audit a run without reaching for `jq`.
- **Message Claude from Telegram** — `afk telegram setup` walks you through bot token + allowlist. After that you have a private chat surface backed by the same session manager as the REPL.
- **Built-in orchestrators** — `/mint`, `/diagnose`, `/spec`, `/research`, `/ship`, `/review` dispatch subagent waves. `/mint` takes a feature idea and runs spec → research → plan → parallelize → build → verify → ship. `/diagnose` forks parallel root-cause hypotheses for failing tests and bugs.

> **Agent AFK Pro:** Autonomous skill-generation (`/forge`) and the calibrated skill-qualification rubric (`/qualify`) are reserved for Agent AFK Pro and are not part of the open-source build.
- **Cross-session memory** — Claude remembers preferences, decisions, and procedures across runs. See [Memory](#memory) below.
- **Background subagent jobs** — dispatch a subagent with `mode:'background'`; `/bgsub` lists running and completed jobs, `/bgsub:join <id>` retrieves the result.

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

## Memory

Claude remembers things across sessions — preferences, decisions, conventions, and reusable procedures — without any manual setup. Memory is local-only and stored under `~/.afk/state/memory/`.

**Two storage tiers:**

- **Hot memory** (`~/.afk/state/memory/HOT.md`) — a small markdown file (≤ ~1,500 tokens) injected into every future session's system prompt automatically. Use it for the facts you want Claude to always carry: your name, working style, standing instructions. Capped at 5,250 characters; overflow is truncated with a sentinel comment.
- **Fact archive** (`~/.afk/state/memory/memory.db`) — an unbounded SQLite store, full-text-searchable via FTS5. Facts are queried on demand with the `memory_search` tool; they don't bloat every prompt.

**Fact categories** (set when writing to the archive):

| Category | What to put here |
|---|---|
| `preference` | Working style, formatting, tool choices |
| `convention` | Naming rules, file layout, team norms |
| `decision` | Architecture choices and the reasoning behind them |
| `learning` | Bugs found, lessons from past runs |

**Tools available inside a session:**

- `memory_search` — full-text search across facts and procedures (supports FTS5: `AND`, `OR`, `NOT`, `"exact phrase"`, `prefix*`).
- `memory_update` — write or supersede a fact in the archive (`target: "fact"`) or overwrite hot memory (`target: "hot"`).
- `procedure_write` — save a reusable step-by-step workflow as a named markdown file under `~/.afk/state/memory/procedures/`. Procedures are searchable via `memory_search`.

Hot memory is injected at session start; `memory_search` is called explicitly during a run. The session-end hook logs each completed top-level session to the archive automatically — subagent sessions are excluded.

All four surfaces (REPL, chat, daemon, Telegram) share the same store — memory written in one surface is available everywhere.

## Models

Default is `sonnet`. Override per-call with `--model`:

```bash
afk chat "explain this stack trace" --model opus_1m
afk --model sonnet_1m
afk chat "refactor this" --model gpt-5.5
```

| Model | Best for |
|---|---|
| `fable` | Most capable — Claude Fable 5 (Mythos-class), hardest reasoning + long-horizon agentic work (1M context) |
| `opus` | Complex reasoning, multi-step planning, long contexts |
| `sonnet` | Day-to-day default — balanced speed and capability |
| `haiku` | Fast, cheap, meh... |

**Model slots** — rebind any capability tier to any model:

| Slot | Default | Notes |
|---|---|---|
| `local` | *(empty — you configure)* | Point at Ollama, LM Studio, or any OpenAI-compatible shim via `AFK_MODEL_LOCAL` + `AFK_MODEL_LOCAL_BASE_URL` |
| `small` | `claude-haiku-4-5-20251001` | Cheapest/fastest Anthropic tier; `haiku` alias |
| `medium` | `claude-sonnet-4-6` | General-use default; `sonnet` alias |
| `large` | `claude-opus-4-8` | Most capable; `opus` alias |

See [`docs/model-slots.md`](docs/model-slots.md) for the full configuration reference.

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

### Queue management

`afk queue` manages the pull-trigger daemon's task queue — tasks are persisted as JSON files and consumed one-by-one by `afk daemon --trigger pull`.

```bash
afk queue add "/forge-friction --auto" --notify-on failure
                         # enqueue a command; daemon picks it up on next poll
afk queue list           # print all pending tasks (id, enqueued time, command)
afk queue remove <id>    # drop a single pending task by id
afk queue clear          # remove all pending tasks (prompts for confirmation)
afk queue clear --yes    # clear without prompting (CI / non-interactive)
```

### Self-improvement pipeline

`afk improve` is a zero-LLM, deterministic pipeline that mines `~/.afk/state/witness/` session traces for ranked failure patterns, without making any model calls.

```bash
# Scan traces for failure patterns (dry-run; add --write to persist cards)
afk improve scan [--since 7d] [--write] [--only <detector,...>]

# Inspect failure cards
afk improve cards list [--pattern <name>] [--severity <level>] [--status open|deferred|resolved]
afk improve cards show <slug>
afk improve cards triage <slug> --note "..." [--status resolved]

# Draft a template-mode improvement proposal for a card (no LLM)
afk improve propose <slug> [--no-write]

# Generate a replay-mode eval-case from a failure card
afk improve eval-gen <cardSlug> [--evidence-row <i>] [--no-write]

# Run the deterministic guardrail contract for an eval-case
afk improve eval-run <evalCaseIdOrCardSlug> [--no-write]
```

Available detectors (run `afk improve scan --help` for thresholds): `repeated-tool-use`, `subagent-block`, `closure-anomaly`, `tool-failure-density`.

### Speculative branch farm

`afk farm` spawns N isolated git worktrees, runs an agent on each in parallel, scores the results (tests + lint + LoC delta), and prints a ranked summary.

```bash
afk farm "add retry logic to the queue consumer" --branches 3
afk farm "<task>" -n 5 --model sonnet --fail-fast
afk farm "<task>" -n 3 --no-score    # skip post-run scoring
afk farm "<task>" -n 3 --labels "approach-a,approach-b,approach-c"
afk farm "<task>" -n 3 --no-memory --no-digest  # skip memory write + Telegram
```

Each branch gets a dedicated worktree under `~/.afk/state/farm/`. A commit-count escape check confirms each agent did real work. On completion, the winner (branch that passes tests and makes the smallest net change) is surfaced; the rest are left for manual cherry-pick or deletion.

## A note on permissions

`afk` does not prompt before each tool call — there is no per-tool approval flow. Claude runs bash, reads and writes files, fetches URLs, and calls MCP servers without asking each time. This is intentional — `afk` is built for unattended work, where a permission prompt with no human in front of it is just a wedged session.

**New installs default to bypass mode.** `afk chat` and `afk interactive` start in `permissionMode: "bypassPermissions"` when `afk.config.json` sets none — the agent reads and writes **anywhere** with no path-approval prompt. This is the equivalent of Claude Code's `--dangerously-skip-permissions`, on by default; use `afk` only on a machine and account you trust. Bypass does not change `ask_question` — that is the model choosing to ask you something, a separate axis.

**To re-enable path containment**, set the mode back any of these ways:

- Persistently: `afk config set permissionMode default` (or `plan`), or `"permissionMode": "default"` in `afk.config.json`. It stays that way until you change it again.
- For one session: `/bypass off` in the REPL (the status line clears `⚡ bypass`).

With containment on (`default`), a file tool (read/write/edit/list/glob/grep) targeting a path *outside* the session's working directory triggers a **path-approval** prompt; pre-authorize paths with `/allow-dir <path>` (or answer "persist" at the prompt to remember them across sessions). Toggle bypass live anytime with `/bypass`. `afk daemon` always runs in bypass (no human to prompt); **Telegram** sessions stay contained (`default`) and rely on hook-based enforcement.

## Troubleshooting

**`invalid x-api-key` / `ANTHROPIC_API_KEY not found`** — run `afk doctor`. Confirm the key is set in your shell or in `~/.afk/config/afk.env`.

**`Cannot send message: session is closed`** — the session timed out or was closed. Start a new one (`afk i` or a fresh `afk chat`).

**`Maximum turns exceeded`** — safety rail tripped. Bump it with `--max-turns 50` or higher.

**Hit the budget cap** — raise `AFK_MAX_BUDGET_USD` or unset it for the session.

**Telegram bot won't start** — `afk telegram status` then `afk telegram logs`. Most common cause: missing `AFK_TELEGRAM_ALLOWED_CHAT_IDS` after token setup.

## Changelog

Recent releases at [`CHANGELOG.md`](CHANGELOG.md), also viewable in-REPL via `/changelog`.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=griffinwork40/agent-afk&type=Date)](https://star-history.com/#griffinwork40/agent-afk&Date)

If Agent AFK saves you time, **[⭐ star the repo](https://github.com/griffinwork40/agent-afk/stargazers)** — it's the single best way to help it reach more people.

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
