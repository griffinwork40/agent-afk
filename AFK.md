# agent-afk

## What This Is

Standalone TypeScript CLI + daemon + Telegram bot built on `@anthropic-ai/sdk`. Runs **outside** Claude Code as its own process. Binary: `afk`. Node ≥22, pnpm-only (lockfile is pnpm-specific).

## Commands

```bash
pnpm install                                       # pnpm exclusively
pnpm build                                         # tsc + copy *.md prompts → dist/
pnpm test                                          # vitest run (all)
pnpm test src/agent/session.test.ts                # single file (NO --; pnpm 10 drops args after -- and runs ALL files)
pnpm test src/agent/session.test.ts -t "sends a message"   # single test by name (scope to a file, then filter by -t)
pnpm test:file src/agent/session.test.ts           # --proof alias for a scoped run (script: vitest run)
pnpm test:watch                                    # vitest watch
pnpm test:coverage                                 # CI gate: has coverage floors that `pnpm test` does not enforce
pnpm test:pty                                      # PTY suite — separate config (vitest.pty.config.ts), own CI job
pnpm lint                                          # tsc --noEmit (strict)

pnpm audit:sdk:check                               # CI gate: fail on unlocked SDK symbols (audit:sdk regenerates the doc)
pnpm audit:sdk:update-lock                         # add new symbols → .sdk-dependency.lock.json (edit `reason` before commit)
pnpm audit:env:check                               # CI gate: no raw process.env reads outside src/config/env.ts
pnpm scan:env:check                                # CI gate: docs/env-registry.{json,md} in sync with src/config/env.ts
pnpm audit:chalk:check                             # CI gate: no raw chalk.<color> outside src/cli/palette.ts (--list to find sites)
pnpm fix:pins:check                                # CI gate: SHA-256 pins for vendored agents + bundled skills (pnpm fix:pins to rewrite)
pnpm audit:deps                                    # CI gate: pnpm audit --audit-level=critical --prod
pnpm release                                       # release pipeline (scripts/release.mjs; --dry via release:dry)
```

Every gate above plus `pnpm lint` and `pnpm build` runs on each PR (`.github/workflows/ci.yml`) — run them locally before pushing, not after CI reddens.

### Running

```bash
pnpm dev                                     # tsx watch — live-reloads CLI
afk chat "hi" / afk interactive / afk daemon # one-shot / REPL (alias: afk i) / cron headless runner
pnpm telegram:start                          # Telegram bot
```

### Observability / tracing

Every session writes a **witness trace** — the durable, chronological record of what the agent actually did (tool calls with timing + result bytes + ok/err, subagent lifecycle, session phases). This is the first thing to reach for when reconstructing "what happened" in a past run — not the transcript (prose only) and not the service logs (other processes).

```bash
afk trace show [<session>]  # pretty-print a trace (default "latest"). --all = include low-signal
                            # events; -n 40 = last N; --json = raw NDJSON for jq
afk trace list              # sessions having a trace, newest first (-n/--max <N>, default 20)
```

Traces live at `$AFK_HOME/state/witness/<sessionLabel>/trace.jsonl`. Writer + reader: `src/agent/trace/`; CLI: `src/cli/commands/trace.ts`. **Two things the trace does not answer**: tool *args* (those are in `~/.afk/state/sessions/<id>/events.jsonl`; the trace carries only `inputBytes`) and raw tool *output* (never recorded durably — only `resultBytes`).

One slice of the args gap is now closable on demand: **subagent dispatch prompts**. Set `AFK_CAPTURE_SUBAGENT_PROMPTS=1` and every prompt a parent sends a child is written as a redacted markdown file (frontmatter + verbatim body) to `~/.afk/state/witness/<sessionLabel>/prompts/`. Because a fork resumes its parent's sessionId, one directory holds every prompt that session dispatched — across all six dispatch paths (agent fg/bg, worktree-isolated, compose/DAG, skill forks, in-process callers like mint phases), and across multi-turn children. **Off by default**, deliberately: nothing prunes the witness tree (12,596 dirs / 461 MB on this machine 2026-08-01) and redaction is regex-based, so connection strings, PEM blocks, and PII are *not* caught. Writer: `src/agent/session/subagent-prompt-capture.ts`; capture point is the child's own `sendMessageStreamInternal`, beside the ledger call that forks are gated out of. The trace itself still carries only `promptHead` (80 chars) on `subagent_lifecycle.started` — these files are not referenced by any trace event, so the directory is the index.

One residual bug, worth recognizing: a parent ending mid-wave seals over live children and silently drops their terminal rows (`write()` throws on a sealed writer; `emitSubagentLifecycle` swallows it), so ~3% of dispatched subagents have no recorded fate — ~8% in daemon/cron parallel waves vs ~1% interactive. Detector: an **unmatched `started` in a trace that contains `session_sealed`** — not "a `started` is the last line", which misses it because the seal is written afterward.

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
| `src/config/` | `env.ts` is the **canonical** `process.env` read-point (typed lazy getters + `ENV_REGISTRY`); config mutation + settable-key gating. |
| `src/service/` | macOS LaunchAgent install/manage for always-on telegram bot / daemon (`launchd.ts`). |
| `src/improve/` | Self-improvement pipeline: telemetry scan → eval-gen → eval-run → propose. |
| `src/insights/` | `afk insights` report: telemetry aggregators → recommendations → self-contained HTML → open-in-browser. Import via the `index.ts` barrel, not sub-paths. |
| `src/utils/` | Cross-cutting leaf helpers (diff, errors + classifiers, terminal-sanitize, envFile, cleanupRegistry). No layer imports upward from here. |
| `src/paths.ts` | Every AFK path helper. Two scopes: user (`$AFK_HOME/`) and project (`<cwd>/.afk/`). Never hand-join AFK paths — call these. |
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

All AFK state under `~/.afk/` (never `~/.claude/`), resolved exclusively through `src/paths.ts`:

```
~/.afk/                          # user-scope ($AFK_HOME)
  config/    afk.env, afk.config.json, mcp.json
  state/     sessions/  todos/  transcripts/  daemon/  witness/   ($AFK_STATE_DIR overrides this tier)
  plugins/   logs/  cache/
  agent-framework/   # AFK telemetry + briefs
<cwd>/.afk/                      # project-scope: per-project skills + plugins, auto-discovered
```

`mcp.json`'s schema matches Claude Code's `mcpServers` block for portability (fields: `src/agent/mcp/types.ts`). Servers connect in parallel at bootstrap; failures are non-fatal **unless** `alwaysLoad: true`. The plugin surface writes to `~/.claude/agent-framework/` independently — no shared state.

### System prompt discovery

The base system prompt is **layered**: the framework prompt (`prompts/system-prompt.md`, inlined at publish-build) is the unconditional foundation; the operator overlay is **appended** beneath an `# Operator configuration` header — never a replacement. `resolveBaseSystemPrompt()` (`src/cli/shared-helpers.ts`) layers them for every top-level surface (chat, REPL, Telegram, farm). `loadConfig()` resolves the overlay across three tiers (highest wins); `loadConfig().systemPrompt` is that overlay alone, and no tier resolving yields `undefined`:

| Tier | Overlay source | `loadConfig().systemPromptSource` |
|------|--------|----------------------|
| 1 | `AFK_SYSTEM_PROMPT` env | `env:AFK_SYSTEM_PROMPT` |
| 2 | `afk.config.json` (cwd → `~/.afk/config/` → legacy) | `file:<abs>` |
| 3 | `AFK.md` (cwd **+** `$AFK_HOME/`, additive) | `afk-md:<abs>` or `afk-md:<user-abs>+afk-md:<project-abs>` |

`AFK.md` is plain markdown, no frontmatter; empty/whitespace counts as absent per-file. The framework base is always present regardless of tier — this file is itself a tier-3 overlay. Tier 3 is **additive, not exclusive**: `loadAfkMd()` (`src/cli/config/afk-md-tier.ts`) reads *both* `$AFK_HOME/AFK.md` and `<cwd>/AFK.md` when both are non-empty and concatenates them (user-scope first, then project-scope under a `## Project configuration … takes precedence on conflict` header) rather than letting the project file hide the personal one; dedup runs through `realpath`. With one tier resolving — the common case — output is byte-identical to a single-tier read: no header, no behavior change. Delivery is baked into the system prompt, *not* a synthetic user-turn message (unlike Claude Code's CLAUDE.md), and is never forwarded to the SDK as a preset; `--dump-prompt` reports the composed source (`framework+afk-md:<user>+afk-md:<project>`, …). Every overlay appends — there is no full-replace escape hatch yet.

## Conventions

- **`tsconfig.json` is maximally strict**: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`. All code must pass `tsc --noEmit`.
- The agent-afk system prompt is the framework base (`prompts/system-prompt.md`) with the operator overlay (env/config/AFK.md) appended, composed by `resolveBaseSystemPrompt()` and sent to the Messages API as a raw string. No SDK preset is loaded.
- `AgentSession` constructor is **synchronous**; SDK lifecycle runs async via `initSdkLifecycle()` and surfaces through the provider event stream.
- DAG executor (`src/agent/dag.ts`, 266 LOC) is fully implemented: layer-by-layer Kahn execution, per-node `AbortController`s, fail-fast with transitive skip, node-level timeouts.
- **SDK dependency tracking**: every import from `@anthropic-ai/sdk` is in `.sdk-dependency.lock.json`. CI fails on unlocked new symbols. After adding an SDK import, run `pnpm audit:sdk:update-lock` and edit the new entry's `reason` field before commit.
- **Three mandatory indirections — each has exactly one read/write point, and CI enforces it.** Env vars: never `process.env`; use the typed `env` object and register new vars in `ENV_REGISTRY` (`src/config/env.ts`; `audit:env:check` + `scan:env:check`). Styling: never `chalk.<color>()`; use the semantic palette (`src/cli/palette.ts`; `audit:chalk:check` — ~180 raw sites had crept back before this gate). Paths: never hand-join anything under `~/.afk/`; use `src/paths.ts` (user- vs project-scope differ and `$AFK_HOME`/`$AFK_STATE_DIR` override).
- Build copies `*.md` prompt files from `src/` into `dist/` via `scripts/copy-prompts.js` — required for built skills to find their prompts.
- Vendored agents under `src/skills/_agents/` must stay byte-equal to upstream, and bundled skills under `src/bundled-plugins/` are SHA-256 pinned in their test files. Editing either intentionally means running `pnpm fix:pins` to rewrite the pins (`pnpm fix:pins:check` is the CI gate); an unexplained pin failure means an edit you did not intend.
- **Three agent-instruction files, different consumers**: this file is the AFK overlay; `CLAUDE.md` targets Claude Code and carries the same facts in longer form (incl. the long-comment audit recipe); `AGENTS.md` is generic operating protocol with no repo specifics. When architecture changes, `AFK.md` and `CLAUDE.md` both need the edit — they drifted apart once already on the provider layer.

### Long-comment prefix convention

Any source-comment block ≥15 contiguous lines must open with one of:

- `// Invariant:` — ordering constraint, protocol rule, externally-governed semantic. Stays inline.
- `// Contract:` — param/return/throws semantics, type-narrowing rationale. Stays inline.
- `// History:` — root-cause, decision log, postmortem. Migrates to `docs/<area>.md` on next touch; leave a ≤5-line summary + link in place.

Choose the prefix before writing the body. When in doubt between `Invariant:` and `History:`, use `Invariant:` — false-shrink is a regression. JSDoc may carry the prefix in the body (`* Invariant: …`).

**There is no linter gate for this** — `tsc` and CI will not catch a missing prefix, so it is review-enforced and self-checked. `CLAUDE.md` carries a ready-to-run grep+awk audit recipe for finding untagged ≥15-line blocks.

### Ordered-operation sequences

Before generating sequences of terminal writes, async state mutations, or persistence-then-UI ops:

- Name the external constraint governing the sequence (protocol / event-loop boundary / semantic invariant).
- Emit the constraint as a code comment, not just in reasoning.
- TUI code: write teardown **before** setup in the source file so the inverse is never orphaned.
- No optimistic rendering — never emit a UI update before its dependent write has a confirmed result, unless explicitly specified.

Source: pattern card `agents-fail-ordered-sequences-when-constraint-is-externally-governed` (charged).
