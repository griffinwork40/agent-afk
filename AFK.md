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
pnpm audit:filesize:check                          # CI gate: 350-line source ceiling, ratcheted against .filesize-baseline.json
pnpm audit:filesize:update                         # regenerate the baseline after a split (NEVER hand-edit loc values)
pnpm audit:funcsize:check                          # CI gate: 200-line function ceiling, ratcheted against .funcsize-baseline.json
pnpm audit:funcsize:update                         # regenerate the function baseline after an extraction
pnpm audit:module-state:check                      # CI gate: no module-scope singleton/process.on duplicated across a sibling family
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

The other half of that gap — **what a child actually SAID** — is closable with `AFK_CAPTURE_SUBAGENT_OUTPUT=1`. This appends a redacted markdown transcript per child to `~/.afk/state/witness/<sessionLabel>/outputs/<subagentId>.md`, recording assistant prose interleaved with **each tool call and its arguments** (the args the trace omits entirely). Same fork/session-label semantics and same off-by-default rationale as the prompts flag above. Writer: `src/agent/session/subagent-output-capture.ts`; same capture point (the child's own `sendMessageStreamInternal`), recorder is session-scoped so a multi-turn child yields one transcript.

Capture is **incremental — flushed at every tool-call boundary — and that is the whole point**, not an optimization. The failure this exists to debug is a child that runs to its timeout and produces zero final output; at that moment every aggregate source is empty *by construction*: `conversationHistory` only gains an entry on `assistant.message` (once per completed `run()`), `SubagentStop.lastMessage` is `undefined`, and the trace's `partialOutputBytes` is `0`. Any capture pinned to an end-of-run boundary records nothing in exactly the case it is needed. Flushing per tool call means a killed child still leaves one record per call it made.

One residual bug, worth recognizing: a parent ending mid-wave seals over live children and silently drops their terminal rows (`write()` throws on a sealed writer; `emitSubagentLifecycle` swallows it), so ~3% of dispatched subagents have no recorded fate — ~8% in daemon/cron parallel waves vs ~1% interactive. Detector: an **unmatched `started` in a trace that contains `session_sealed`** — not "a `started` is the last line", which misses it because the seal is written afterward.

### Subagent tool-round budget

The unit of the budget cap is **tool-use rounds**, not tool calls — 5 parallel calls in one reply consume 1 round, not 5. Default ceiling: **50 rounds per fork**; `0` = unbounded. Hitting the cap triggers a wind-down round (tools stripped from the next reply) rather than a kill, so the child returns partial work instead of dying mid-sentence. Each child is told its own budget at dispatch via the preamble injected by `src/agent/session/budget-preamble.ts`. Full history and rationale: `docs/subagent-tool-budget.md`.

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

### The 350-line ceiling

No source file under `src/` or `scripts/` exceeds **350 raw lines** (`wc -l`
semantics). Gate: `pnpm audit:filesize:check` (`scripts/check-file-size.ts`),
with a non-failing warn band at 316–350. Tests, `__fixtures__`, `__test-utils__`,
and `.d.ts` are out of scope — a 3,000-line test file is a flat list of cases an
agent greps into, not a file it must read whole to edit safely.

At the ceiling you pull **one whole concern** into a sibling file. You never shave
lines and never raise the limit. Concretely, for `src/foo/bar.ts` create
`src/foo/bar.<concern>.ts`; the original **never moves** and keeps its exact
public surface, so no importer is ever rewritten. For a file already inside its
own directory, add plain-named siblings into that directory instead.

`.filesize-baseline.json` grandfathers the 138 files that already exceeded the
ceiling when the gate landed, and it is a **one-way ratchet** — it fails when a
non-baselined file goes over, when a baselined file *grows*, when a baselined file
now fits (remove it), and when a baselined path disappears. Regenerate it with
`pnpm audit:filesize:update`; never hand-edit `loc` values (the `reason` and
`permanent` fields are yours and survive regeneration). It carries
`-merge` in `.gitattributes`, so resolve conflicts by regenerating, never
by editing conflict markers.

**Getting under the ceiling without deleting documentation.** This repo mandates
long `Invariant:`/`Contract:`/`History:` comment blocks, and the 136 originally
over the line averaged 45.5% comment+blank. The lever is that **JSDoc travels with
its declaration** — extract a declaration group and its docs go with it, so raw
lines drop with nothing deleted. Never delete, reflow, or condense a comment to
satisfy the gate, and never reclassify an `Invariant:`/`Contract:` block as
`History:` to make it migratable (`History:` may legitimately migrate to
`docs/<area>.md` leaving a ≤5-line summary + link — but only if it was genuinely
`History:` to begin with; false-shrink is a regression).

A split is only behaviour-preserving if state stays singular:
`pnpm audit:module-state:check` fails when the same module-scope singleton or
`process.on` registration is declared in two files of one sibling family. And an
extracted sibling must be reachable from one of the three esbuild entrypoints or
`build:dist` silently tree-shakes it with no CI signal. Campaign plan and
per-wave protocol: `docs/file-size-ceiling.md`.

### The 200-line function ceiling

A sibling gate, and **not implied by the file ceiling**: `pnpm audit:funcsize:check`
(`scripts/check-function-size.ts`) fails when any single function under `src/` or
`scripts/` exceeds **200 lines**. File size measures how much you must *read* to
edit safely; function size measures how much you must *hold in mind* to change one
behaviour. They diverge both ways — a flat 900-line registry has no large function,
and a 700-line function hides inside a file that passes 350 only because siblings
were extracted around it (#919: #829 shrank `subagent.ts` and closed while
`forkSubagent` never changed, and it has since grown to 586).

Same five-mode ratchet and the same never-hand-edit rule, against
`.funcsize-baseline.json` (54 grandfathered = 1.2% of 4,388 functions; regenerate
with `pnpm audit:funcsize:update`). Measurement is AST-based, so **JSDoc is
excluded** — unlike the file metric, which counts it. The asymmetry is deliberate:
extraction relieves a file ceiling and carries the docs along, but a function
cannot be split from its own doc comment, so counting it would only pressure you
to delete documentation.

At the ceiling, extract a **named helper taking explicit parameters** — not a
closure over the enclosing locals, which relocates lines without reducing what you
must hold in mind. `pnpm audit:funcsize:list` ranks the current worst.

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
