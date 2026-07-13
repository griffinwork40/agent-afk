# agent-afk

## What This Is

Standalone TypeScript CLI + daemon + Telegram bot built on `@anthropic-ai/sdk`. Runs **outside** Claude Code as its own process. Binary: `afk`. Node ≥22, pnpm-only (lockfile is pnpm-specific).

## Commands

```bash
pnpm install                                       # pnpm exclusively
pnpm build                                         # tsc + copy *.md prompts → dist/
pnpm test                                          # vitest run (all)
pnpm test -- src/agent/session.test.ts             # single file
pnpm test -- -t "sends a message"                  # single test by name
pnpm test:watch                                    # vitest watch
pnpm lint                                          # tsc --noEmit (strict)

pnpm audit:sdk                                     # regenerate docs/sdk-dependency.md
pnpm audit:sdk:check                               # CI gate: fail on unlocked SDK symbols
pnpm audit:sdk:update-lock                         # add new symbols → .sdk-dependency.lock.json (edit `reason` before commit)

pnpm audit:env:check                               # CI gate: no raw process.env reads outside src/config/env.ts
pnpm scan:env:check                                # CI gate: docs/env-registry.{json,md} in sync with src/config/env.ts
pnpm release                                       # release pipeline (scripts/release.mjs; --dry via release:dry)
```

### Running

```bash
pnpm dev                  # tsx watch — live-reloads CLI
afk chat "hello"          # one-shot
afk interactive           # REPL (alias: afk i)
afk daemon                # cron-based headless runner
pnpm telegram:start       # Telegram bot
```

### Observability / tracing

Every session writes a **witness trace** — the durable, chronological record of what the agent actually did (tool calls with timing + result bytes + ok/err, subagent lifecycle, session phases). This is the first thing to reach for when reconstructing "what happened" in a past run — not the transcript (prose only) and not the service logs (other processes).

```bash
afk trace show              # pretty-print the latest session's trace (default: "latest")
afk trace show <session>    # a specific session id
afk trace show --all        # include low-signal events (latency phases, paired tool starts)
afk trace show -n 40        # only the last N events
afk trace show --json       # raw NDJSON, unchanged — pipe to jq
afk trace list              # sessions that have a trace, most recent first (-n/--max <N>, default 20)
```

Traces live at `~/.afk/state/witness/<session>/trace.jsonl` (`$AFK_HOME/state/witness/<sessionLabel>/trace.jsonl`). Writer + reader: `src/agent/trace/`; CLI: `src/cli/commands/trace.ts`. Known gaps (do not assume the trace answers these): tool **args** live in `~/.afk/state/sessions/<id>/events.jsonl`, not the witness trace; raw tool **output** is not recorded anywhere durable; a usage-limit **pause** has no event (silent gap); subagent-spawning calls may record `started` without a terminal if the write races the session seal.

## Architecture

Key layers under `src/`:

| Path | Purpose |
|------|---------|
| `src/agent/` | Provider-agnostic session harness. `AgentSession` is the single runtime entry point; delegates to a `ModelProvider` from `providerForModel()`. |
| `src/agent/providers/anthropic-direct/` | Wraps `@anthropic-ai/sdk` Messages API. Default for `claude-*`, `opus`, `sonnet`, `haiku`. `'anthropic'` is a silent alias. |
| `src/agent/providers/openai-compatible/` | Talks directly to OpenAI's Chat Completions API (and any compatible endpoint via baseURL). Default for `gpt-*`, `o1*`, `o3*`, `o4*`, `codex-*`, **and** HuggingFace-style `org/model` ids (mlx-community/…, Qwen/…) served by local OpenAI-shim runners (MLX, llama.cpp, vLLM, ollama-openai). `'openai-codex'` is a deprecated alias from the pre-2026-05-18 codex-sdk era. |
| `src/cli/` | Commander-based terminal surface. Commands in `src/cli/commands/`. REPL: `commands/interactive/` (bootstrap → loop → turn → markdown stream → cleanup). Slash commands in `src/cli/slash/` via Levenshtein-hint dispatcher. |
| `src/telegram/` | Telegraf bot, per-chat session management, allowlist via `AFK_TELEGRAM_ALLOWED_CHAT_IDS`. |
| `src/skills/` | Headless mirrors of plugin orchestration skills. Each has `prompts/` (markdown) loaded by `src/skills/_lib/prompt-loader.ts`. |
| `src/skills/_agents/` | Vendored agent definitions. Drift detection: `vendored.test.ts`. |
| `src/browser/` | Playwright-backed browser-control tools (open/observe/act/screenshot) + witness capture and domain-policy sanitization. |
| `src/web/` | `web_scrape` pipeline: fetch → Readability → markdown extraction, with headless-render fallback and Exa search. |
| `src/config/` | `env.ts` is the **sole** `process.env` read-point (typed lazy getters + `ENV_REGISTRY`); config mutation + settable-key gating. |
| `src/service/` | macOS LaunchAgent install/manage for always-on telegram bot / daemon (`launchd.ts`). |
| `src/improve/` | Self-improvement pipeline: telemetry scan → eval-gen → eval-run → propose. |
| `src/bundled-plugins/` | Plugins shipped with the package (copied at install; `tests/copy-bundled-plugins.test.ts`). |
| `website/` | Next.js docs site (separate package, npm-locked; CI typechecks + builds it). |

Both providers emit a normalized `ProviderEvent` stream consumed by `src/agent/session/stream-consumer.ts`. **No model SDK is imported for runtime use outside `src/agent/providers/`** — the rest of the tree imports only the SDK's `ContentBlockParam` *type*. The only runtime `import Anthropic from '@anthropic-ai/sdk'` statements live in `src/agent/providers/anthropic-direct/` (`index.ts`, `oneshot.ts`).

### Cross-cutting subsystems

- **Hooks** (`src/agent/hooks.ts`, `hook-registry.ts`) — SessionStart/End, SubagentStart/Stop, PreToolUse/PostToolUse. Sequential; `decision: 'block'` short-circuits. SubagentStop supports `injectContext` for parent-session context injection.
- **SubagentManager** (`src/agent/subagent.ts`) — Forks child `AgentSession`s with permission bubbling, transitive abort via `AbortGraph`, optional Zod output schemas.
- **AbortGraph** (`src/agent/abort-graph.ts`) — Tree of `AbortController`s. Parent abort cascades down; child abort notifies up (never auto-aborts parent). Abort beats hook decisions.
- **Elicitation Router** (`src/agent/elicitation-router.ts`) — Module-scope handler bridging SDK elicitations to REPL/Telegram/iMessage surfaces.
- **Plugins** (`src/agent/plugins-scanner.ts`, `src/agent/plugins/`) — Scans `~/.afk/plugins/` at session construction; install/remove/update + git-based sources.
- **MCP client** (`src/agent/mcp/`) — Wraps `@modelcontextprotocol/sdk`. `McpManager.fromConfig()` connects every server resolved by `loadMcpConfig()`. Config layers (lowest → highest priority): plugin-contributed `<plugin>/.claude-plugin/mcp.json` → `~/.afk/config/mcp.json` → `<cwd>/.mcp.json` → `--mcp-config <path>`. Per-name conflicts: higher layer wins, displaced source surfaced as a warning. Transports: stdio + streamable-HTTP + SSE fallback + OAuth. Tools are bridged as `mcp__<server>__<tool>` and read fresh per-query in the dispatcher so `notifications/tools/list_changed` refreshes are picked up without restarting the session. Per-surface manager (REPL); subagents share parent by reference. Sampling capability deliberately not advertised — eliminates the "stub or hang" footgun. `/mcp` lists servers; `/mcp auth` surfaces pending OAuth URLs from `~/.afk/state/mcp/server-status.json`.

### User-scope state

All AFK state under `~/.afk/` (never `~/.claude/`):

```
~/.afk/
  config/    afk.env, afk.config.json, mcp.json
  state/     sessions/  todos/  transcripts/  daemon/   ($AFK_STATE_DIR overrides this tier)
  plugins/   logs/  cache/
  agent-framework/   # AFK telemetry + briefs (via paths.ts)
```

`mcp.json` is the MCP server registry. Schema matches Claude Code's `mcpServers` block for portability — see `src/agent/mcp/types.ts` for fields. Loaded eagerly at session bootstrap from layered sources (plugin → user-global → project-local `<cwd>/.mcp.json` → `--mcp-config` flag, higher wins). Servers connect in parallel; failures are non-fatal unless `alwaysLoad: true`. Tools are exposed as `mcp__<server>__<tool>` and routed via the standard dispatcher (Pre/PostToolUse hooks fire automatically). `tools/list_changed` notifications trigger an in-place tool-list refresh — the next tool_use round sees the updated set without restart.

The plugin surface writes to `~/.claude/agent-framework/` independently — no shared state.

### System prompt discovery

The base system prompt is **layered**: the framework prompt (`prompts/system-prompt.md`, inlined at publish-build) is the unconditional foundation; the resolved operator overlay is **appended** on top beneath an `# Operator configuration` header — never a replacement. `resolveBaseSystemPrompt()` (`src/cli/shared-helpers.ts`) layers them for every top-level surface (chat, REPL, Telegram, farm).

`loadConfig()` resolves the **operator overlay** across three tiers (highest wins); `loadConfig().systemPrompt` is that overlay alone:

| Tier | Overlay source | `loadConfig().systemPromptSource` |
|------|--------|----------------------|
| 1 | `AFK_SYSTEM_PROMPT` env | `env:AFK_SYSTEM_PROMPT` |
| 2 | `afk.config.json` (cwd → `~/.afk/config/` → legacy) | `file:<abs>` |
| 3 | `AFK.md` (cwd → `$AFK_HOME/`) | `afk-md:<abs>` |
| — | None | `undefined` |

`AFK.md` is plain markdown, no frontmatter. Empty/whitespace → treated as absent. The framework base is always present regardless of overlay tier (this file, `AFK.md`, is itself a tier-3 overlay appended to the framework base). `--dump-prompt` reports a composed `systemPromptSource` (`framework`, `framework+afk-md:<path>`, …); never forwarded to the SDK as a preset. Every overlay appends — no full-replace escape hatch yet (a future `AFK_BASE_PROMPT=0` would add one).

## Conventions

- **`tsconfig.json` is maximally strict**: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`. All code must pass `tsc --noEmit`.
- The agent-afk system prompt is the framework base (`prompts/system-prompt.md`) with the operator overlay (env/config/AFK.md) appended, composed by `resolveBaseSystemPrompt()` and sent to the Messages API as a raw string. No SDK preset is loaded.
- `AgentSession` constructor is **synchronous**; SDK lifecycle runs async via `initSdkLifecycle()` and surfaces through the provider event stream.
- DAG executor (`src/agent/dag.ts`, 266 LOC) is fully implemented: layer-by-layer Kahn execution, per-node `AbortController`s, fail-fast with transitive skip, node-level timeouts.
- **SDK dependency tracking**: every import from `@anthropic-ai/sdk` is in `.sdk-dependency.lock.json`. CI fails on unlocked new symbols. After adding an SDK import, run `pnpm audit:sdk:update-lock` and edit the new entry's `reason` field before commit.
- **Env-var access**: never read `process.env` directly — use the typed `env` object from `src/config/env.ts` and register new vars in `ENV_REGISTRY` there (CI-gated by `pnpm audit:env:check` + `pnpm scan:env:check`).
- Build copies `*.md` prompt files from `src/` into `dist/` via `scripts/copy-prompts.js` — required for built skills to find their prompts.
- Vendored agents under `src/skills/_agents/` must stay byte-equal to upstream — drift detection enforces it.

### Long-comment prefix convention

Any source-comment block ≥15 contiguous lines must open with one of:

- `// Invariant:` — ordering constraint, protocol rule, externally-governed semantic. Stays inline.
- `// Contract:` — param/return/throws semantics, type-narrowing rationale. Stays inline.
- `// History:` — root-cause, decision log, postmortem. Migrates to `docs/<area>.md` on next touch; leave a ≤5-line summary + link in place.

Choose the prefix before writing the body. When in doubt between `Invariant:` and `History:`, use `Invariant:` — false-shrink is a regression.

### Ordered-operation sequences

Before generating sequences of terminal writes, async state mutations, or persistence-then-UI ops:

- Name the external constraint governing the sequence (protocol / event-loop boundary / semantic invariant).
- Emit the constraint as a code comment, not just in reasoning.
- TUI code: write teardown **before** setup in the source file so the inverse is never orphaned.
- No optimistic rendering — never emit a UI update before its dependent write has a confirmed result, unless explicitly specified.

Source: pattern card `agents-fail-ordered-sequences-when-constraint-is-externally-governed` (charged).
