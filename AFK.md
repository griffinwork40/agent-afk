# agent-afk

## What This Is

Standalone TypeScript CLI + daemon + Telegram bot built on `@anthropic-ai/sdk`. Runs **outside** Claude Code as its own process. Binary: `afk`. Node ≥22.13 (pnpm 11 minimum), pnpm 11 only (pinned via `package.json#packageManager`; lockfile is pnpm-specific; dependency build scripts must be allowlisted under `allowBuilds` in `pnpm-workspace.yaml`, and `dashboard/` has its own copy). CI publishes with `npm publish`/`npm version`, not the pnpm equivalents; see the Invariant in `.github/workflows/publish.yml`.

## Commands

```bash
pnpm install                                       # pnpm exclusively
pnpm build                                         # tsc + copy *.md prompts → dist/
pnpm test                                          # vitest run (all)
pnpm test src/agent/session.test.ts                # single file (NO --; pnpm 10+ drops args after -- and runs ALL files)
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
pnpm audit:filesize:check                          # 350-code-line ceiling (comments/blanks excluded), ratcheted against .filesize-baseline.json — CI runs it but NON-blocking (`|| true`) until #2206 lands; treat a failure as yours to fix
pnpm audit:filesize:update                         # regenerate the baseline after a split (NEVER hand-edit loc values; add --allow-growth --reason "<text>" to record a deliberate increase)
pnpm audit:funcsize:check                          # CI gate: 200-line function ceiling (AST-measured), ratcheted against .funcsize-baseline.json
pnpm audit:funcsize:update                         # regenerate the function baseline after an extraction (add --allow-growth --reason "<text>" to record a deliberate increase)
pnpm audit:module-state:check                      # CI gate: no module-scope singleton/process.on duplicated across a sibling family
pnpm fix:pins:check                                # CI gate: SHA-256 pins for vendored agents + bundled skills (pnpm fix:pins to rewrite)
pnpm audit:deps                                    # CI gate: pnpm audit --audit-level=critical --prod
pnpm check:audits                                  # run all deterministic CI audit gates locally (full-scan; exit 0=pass, 1=some failed, 2=all failed→broken env)
pnpm release                                       # release pipeline (scripts/release.mjs; --dry via release:dry)
```

Every gate above plus `pnpm lint` and `pnpm build` runs on each PR (`.github/workflows/ci.yml`) — run them locally before pushing, not after CI reddens.

### Running

```bash
pnpm dev                                     # tsx watch — live-reloads CLI
afk chat "hi" / afk interactive / afk daemon # one-shot / REPL (alias: afk i) / cron headless runner
pnpm telegram:start                          # Telegram bot
```

### Pre-push hook

`pnpm install` (via the `prepare` lifecycle script) installs a launcher at `.git/hooks/pre-push` (the git common dir, covering all worktrees). Before every push it runs `pnpm check:audits` — the same deterministic audit gates CI runs in the lint-build job. If the environment looks broken (node_modules missing or pnpm not on PATH) the hook exits 0 (fail-open). Bypass with `git push --no-verify`.

### Observability / tracing

Every session writes a **witness trace** — the durable, chronological record of what the agent actually did (tool calls with timing + result bytes + ok/err, subagent lifecycle, session phases). This is the first thing to reach for when reconstructing "what happened" in a past run — not the transcript (prose only) and not the service logs (other processes).

```bash
afk trace show [<session>]  # pretty-print a trace (default "latest"). --all = include low-signal
                            # events; -n 40 = last N; --json = raw NDJSON for jq
afk trace list              # sessions having a trace, newest first (-n/--max <N>, default 20)
```

Traces live at `$AFK_HOME/state/witness/<sessionLabel>/trace.jsonl`. Writer + reader: `src/agent/trace/`; CLI: `src/cli/commands/trace.ts`. **Two things the trace does not answer**: tool *args* (those are in `~/.afk/state/sessions/<id>/events.jsonl`; the trace carries only `inputBytes`) and raw tool *output* (never recorded durably — only `resultBytes`). **Exception for failures**: when a tool call returns `isError: true` with non-empty content, `tool_call.completed` now carries `errorHead` — the first ≤200 characters of the error text, newlines collapsed, passed through `redactSecrets` (common token shapes replaced with `[REDACTED]`). This is enough to classify failure kind (stale edit, wrong path, policy text) without storing the full output. Regex redaction is best-effort; connection strings, PEM blocks, and PII are not caught.

**Trace self-identification.** Every trace now records a `session_id_assigned` event (a `session_phase` kind) the moment the provider-issued session id first becomes known — which may be after the first model turn on an interactive session. The event shape is `{ kind: 'session_phase', payload: { phase: 'session_id_assigned', sessionId: '<id>', priorSessionId?: '<prev>' } }`. Consumers (friction analyzer, `afk insights`, harvest) use this to join a trace file (named by its random `sessionLabel` directory) to the corresponding SessionFacet (`~/.afk/agent-framework/facets/<sessionId>.json`) and session ledger without any side channel. Old traces that predate this event simply lack it — consumers must treat absence as "id unknown from trace alone" and fall back to the ledger `traceLabel` bridge for those older files. Emitter: `src/agent/session/session-id-trace.ts`; wired via `SessionStateManager`'s `onSessionIdAssigned` callback in `buildProviderLifecycle`.

**Many-image degradation trace.** When `enforceManyImageLimit` runs in `openRound` and replaces one or more image blocks with `imageOmitted` text blocks (because the request has >20 images and some exceed the 2 000 px many-image ceiling), it emits a `many_image_degraded` `session_phase` event. Payload: `{ phase: 'many_image_degraded', metadata: { degradedCount, threshold, maxDimension } }`. PURE OBSERVABILITY — the mutation already happened to the messages array; this event makes it visible in the trace so operators can diagnose sessions that silently hit the many-image ceiling. Emitter: `src/agent/providers/anthropic-direct/loop/round-request.ts`.

Both gaps — the dispatch prompt and the child's full conversation — are covered by **subagent journals** (introduced in #2452, retired the two opt-in capture flags in #2460). Every fork writes `~/.afk/state/sessions/<id>/subagents/<subagentId>.jsonl`, recording the dispatch prompt (the child's first user message), every tool call with full arguments, every tool result, and the child's assistant text — a strict superset of what the old `AFK_CAPTURE_SUBAGENT_PROMPTS` / `AFK_CAPTURE_SUBAGENT_OUTPUT` flags wrote. Journal writer: `src/agent/session/journal/`; paths: `src/paths.journal.ts`. The journal syncs via `journalSync.sync(messages)` before each model request and after each tool round (`anthropic-direct/loop/round-request.ts`, `loop/tool-round.ts`; `openai-compatible/query.ts` commits at turn end and at each tool round), with `journal.flush()` called on abort. **View with `afk trace show --results`** or read the JSONL files directly.

Journal writes go through an async `SerialQueue`, so a SIGKILL can lose queued records — the same exposure the old capture flags had (they also flushed asynchronously). A graceful abort calls `journal.flush()` before exit (`src/agent/session/agent-session.ts`), bounding the loss window.

One residual bug, worth recognizing: a parent ending mid-wave seals over live children and silently drops their terminal rows (`write()` throws on a sealed writer; `emitSubagentLifecycle` swallows it), so ~3% of dispatched subagents have no recorded fate — ~8% in daemon/cron parallel waves vs ~1% interactive. Detector: an **unmatched `started` in a trace that contains `session_sealed`** — not "a `started` is the last line", which misses it because the seal is written afterward.

**Witness retention.** The tree is no longer unbounded (`src/agent/witness-sweep.ts`, #849). A sweep runs at root-session start — fire-and-forget beside `capJsonlBySize`, never able to fail construction — and evicts **whole session directories**, first any whose newest content is older than `AFK_WITNESS_MAX_AGE_DAYS` (default **30**), then oldest-first until the tree fits `AFK_WITNESS_MAX_BYTES` (default **2 GiB**). `AFK_WITNESS_RETENTION_DISABLE=1` turns it off entirely. Three properties are load-bearing and each has a test: the **active session is excluded by identity** (its witness label, never by timestamp); anything whose newest content is inside a 1-hour grace window is never evicted, which covers the concurrent REPL/daemon/telegram sessions this process cannot enumerate; and liveness is judged by the **newest mtime across a directory's contents, not the directory's own mtime** — POSIX does not bump a directory's mtime when an existing file inside it is appended to, so a long-running session that creates no new sidecars looks ancient and an mtime-only sweep would delete a live trace. Cost is bounded twice over: the sweep is deferred 5s off the construction path and `.unref()`ed (so a short-lived process never pays for it), and a `.last-sweep` stamp in the witness root caps it at one walk every 6 hours rather than one per session start.

### Subagent tool-round budget

The unit of the budget cap is **tool-use rounds**, not tool calls — 5 parallel calls in one reply consume 1 round, not 5. Default ceiling: **50 rounds per fork**; `0` = unbounded. Hitting the cap triggers a wind-down round (tools stripped from the next reply) rather than a kill, so the child returns partial work instead of dying mid-sentence. Each child is told its own budget at dispatch via the preamble injected by `src/agent/subagent/budget-preamble.ts`, and is told it IS a subagent (reply goes to the dispatching agent, no human reachable, whether it may nest further) by `src/agent/subagent/identity-preamble.ts`; both are applied at `assembleChildConfig`, and every identity line is derived from the child's resolved config so it is never false for that child. Full history and rationale: `docs/subagent-tool-budget.md`.

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
| `src/http-client/` | `web_scrape` pipeline: fetch → Readability → markdown extraction, with headless-render fallback and Exa search. |
| `src/config/` | `env.ts` is the **canonical** `process.env` read-point (typed lazy getters + `ENV_REGISTRY`); config mutation + settable-key gating. |
| `src/service/` | macOS LaunchAgent install/manage for always-on telegram bot / daemon (`launchd.ts`). |
| `src/improve/` | Self-improvement pipeline: telemetry scan → eval-gen → eval-run → propose. |
| `src/insights/` | `afk insights` report: telemetry aggregators → recommendations → self-contained HTML → open-in-browser. Import via the `index.ts` barrel, not sub-paths. |
| `src/whatif/` | What-if prediction engine: `afk whatif` / `/whatif`. ChangeSpec + operators, sandbox materialiser, NL compiler, episode runner, judge (Jev/Claude), stats, report. Docs: `docs/whatif.md`. |
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
  agent-framework/   # AFK telemetry + briefs (forge-telemetry.jsonl, routing-decisions.jsonl,
                   #   preexisting-ledger.jsonl — see docs/preexisting-ledger.md)
<cwd>/.afk/                      # project-scope: per-project skills + plugins, auto-discovered
```

`mcp.json`'s schema matches Claude Code's `mcpServers` block for portability (fields: `src/agent/mcp/types.ts`). Servers connect in parallel at bootstrap; failures are non-fatal **unless** `alwaysLoad: true`. The plugin surface writes to `~/.claude/agent-framework/` independently — no shared state.

### System prompt discovery

The base system prompt is **layered**: the framework prompt (`system-prompt.md`, inlined at publish-build) is the unconditional foundation; the operator overlay is **appended** beneath an `# Operator configuration` header — never a replacement. `resolveBaseSystemPrompt()` (`src/cli/shared-helpers.ts`) layers them for every top-level surface (chat, REPL, Telegram, farm). `loadConfig()` resolves the overlay across three tiers (highest wins); `loadConfig().systemPrompt` is that overlay alone, and no tier resolving yields `undefined`:

| Tier | Overlay source | `loadConfig().systemPromptSource` |
|------|--------|----------------------|
| 1 | `AFK_SYSTEM_PROMPT` env | `env:AFK_SYSTEM_PROMPT` |
| 2 | `afk.config.json` (cwd → `~/.afk/config/` → legacy) | `file:<abs>` |
| 3 | `AFK.md` (cwd **+** `$AFK_HOME/`, additive) | `afk-md:<abs>` or `afk-md:<user-abs>+afk-md:<project-abs>` |

`AFK.md` is plain markdown, no frontmatter; empty/whitespace counts as absent per-file. The framework base is always present regardless of tier — this file is itself a tier-3 overlay. Tier 3 is **additive, not exclusive**: `loadAfkMd()` (`src/cli/config/afk-md-tier.ts`) reads *both* `$AFK_HOME/AFK.md` and `<cwd>/AFK.md` when both are non-empty and concatenates them (user-scope first, then project-scope under a `## Project configuration … takes precedence on conflict` header) rather than letting the project file hide the personal one; dedup runs through `realpath`. With one tier resolving — the common case — output is byte-identical to a single-tier read: no header, no behavior change. Delivery is baked into the system prompt, *not* a synthetic user-turn message (unlike Claude Code's CLAUDE.md), and is never forwarded to the SDK as a preset; `--dump-prompt` reports the composed source (`framework+afk-md:<user>+afk-md:<project>`, …). Every overlay appends — there is no full-replace escape hatch yet.

## Conventions

- **`tsconfig.json` is maximally strict**: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`. All code must pass `tsc --noEmit`.
- The agent-afk system prompt is the framework base (`system-prompt.md`) with the operator overlay (env/config/AFK.md) appended, composed by `resolveBaseSystemPrompt()` and sent to the Messages API as a raw string. No SDK preset is loaded.
- `AgentSession` constructor is **synchronous**; SDK lifecycle runs async via `initSdkLifecycle()` and surfaces through the provider event stream.
- DAG executor (`src/agent/dag.ts`, 266 LOC) is fully implemented: layer-by-layer Kahn execution, per-node `AbortController`s, fail-fast with transitive skip, node-level timeouts.
- **SDK dependency tracking**: every import from `@anthropic-ai/sdk` is in `.sdk-dependency.lock.json`. CI fails on unlocked new symbols. After adding an SDK import, run `pnpm audit:sdk:update-lock` and edit the new entry's `reason` field before commit.
- **Three mandatory indirections — each has exactly one read/write point, and CI enforces it.** Env vars: never `process.env`; use the typed `env` object and register new vars in `ENV_REGISTRY` (`src/config/env.ts`; `audit:env:check` + `scan:env:check`). Styling: never `chalk.<color>()`; use the semantic palette (`src/cli/palette.ts`; `audit:chalk:check` — ~180 raw sites had crept back before this gate). Paths: never hand-join anything under `~/.afk/`; use `src/paths.ts` (user- vs project-scope differ and `$AFK_HOME`/`$AFK_STATE_DIR` override).
- Build copies `*.md` prompt files from `src/` into `dist/` via `scripts/copy-prompts.js` — required for built skills to find their prompts.
- Vendored agents under `src/skills/_agents/` must stay byte-equal to upstream, and bundled skills under `src/bundled-plugins/` are SHA-256 pinned in their test files. Editing either intentionally means running `pnpm fix:pins` to rewrite the pins (`pnpm fix:pins:check` is the CI gate); an unexplained pin failure means an edit you did not intend.
- **Two agent-instruction files, different consumers**: this file is the AFK overlay and the single home for repo-specific facts; `AGENTS.md` is generic operating protocol with no repo specifics. There is no tracked `CLAUDE.md` (removed in 4683427a) — when architecture changes, edit `AFK.md` (and `docs/` where the detail lives), not a parallel copy.

### The 350-code-line ceiling

No source file under `src/` or `scripts/` exceeds **350 code lines** (non-blank,
non-comment). Gate: `pnpm audit:filesize:check` (`scripts/check-file-size.ts`;
its CI steps currently end in `|| true`, so CI will not stop you — #2206),
with a non-failing warn band at 316–350 code lines. Tests, `__fixtures__`,
`__test-utils__`, and `.d.ts` are out of scope — a 3,000-line test file is a flat
list of cases an agent greps into, not a file it must read whole to edit safely.

Comments and blank lines are excluded from the count so documentation is never
penalized. A line-oriented heuristic classifies comments (`//`, block comments,
JSDoc); lines with trailing comments count as code. Write as many `Invariant:`,
`Contract:`, and `History:` blocks as you need — they are free.

At the ceiling you pull **one whole concern** into a sibling file. You never shave
code and never raise the limit. Concretely, for `src/foo/bar.ts` create
`src/foo/bar.<concern>.ts`; the original **never moves** and keeps its exact
public surface, so no importer is ever rewritten. For a file already inside its
own directory, add plain-named siblings into that directory instead.

`.filesize-baseline.json` grandfathers files that exceeded the ceiling when the
gate landed, and it is a **one-way ratchet** — it fails when a non-baselined file
goes over, when a baselined file *grows*, when a baselined file now fits (remove
it), and when a baselined path disappears. Regenerate it with
`pnpm audit:filesize:update`; never hand-edit `loc` values (the `reason` and
`permanent` fields are yours and survive regeneration). Growth is refused unless
you pass `--allow-growth --reason "<why>"` — shrinks and removals are always
allowed. It carries
`-merge` in `.gitattributes`, so resolve conflicts by regenerating, never
by editing conflict markers.

A split is only behaviour-preserving if state stays singular:
`pnpm audit:module-state:check` fails when the same module-scope singleton or
`process.on` registration is declared in two files of one sibling family. And an
extracted sibling must be reachable from one of the three esbuild entrypoints or
`build:dist` silently tree-shakes it with no CI signal. Campaign plan and
per-wave protocol: `docs/file-size-ceiling.md`.

### The 200-line function ceiling

A CI-blocking sibling of the file ceiling — **not implied by it**: `pnpm audit:funcsize:check`
(`scripts/check-function-size.ts`) fails when any single function under `src/` or
`scripts/` exceeds **200 lines** and is not grandfathered. It was advisory until
#1757 promoted it; see the "CI-blocking" funcsize steps in `.github/workflows/ci.yml`.
File size measures how much
you must *read* to edit safely; function size measures how much you must *hold in
mind* to change one behaviour. They diverge both ways — a flat 900-line registry
has no large function, and a 700-line function hides inside a file that passes the
code-line ceiling only because siblings were extracted around it (#919: #829 shrank `subagent.ts`
and closed while `forkSubagent` never changed, and it has since grown to 586).

The baseline ratchet and the never-hand-edit rule still apply, against
`.funcsize-baseline.json` (the grandfathered set is whatever that file holds — count
its entries rather than trusting a number written here; regenerate with
`pnpm audit:funcsize:update`; pass `--allow-growth --reason "<why>"` to record a deliberate increase). Measurement is AST-based, so **JSDoc is
excluded** — same as the file metric, which also excludes comments and blanks.
Both gates measure logic density, not documentation volume.

At the ceiling, extract a **named helper taking explicit parameters** — not a
closure over the enclosing locals, which relocates lines without reducing what you
must hold in mind. `pnpm audit:funcsize:list` ranks the current worst.

### The POSIX-assumption guard

The Windows CI leg runs only on main pushes and `windows-compat`-labelled PRs, so
`tests/posix-guard.test.ts` enforces a static Windows guard inside **`pnpm test`**
(ubuntu CI and auto-release) on every PR (#703). AST rules in
`scripts/lib/posix-guard-rules.ts`: **R1** a literal `/bin/sh`/`sh`/`bash` as the
command of `execFile`/`spawn`/`exec` or as `shell:` in product code (use
`resolveShell()` from `src/utils/resolve-shell.ts`); **R2** `mkdtemp` on a
`/`-rooted literal anywhere (use `path.join(os.tmpdir(), 'afk-<name>-')`); **R3**
host `path.resolve`/`path.normalize` on a `/`-rooted literal in product code (the
#2588 shape; use `path.posix.*` for POSIX-shaped paths); **R4** any test gated on
platform (`skipIf`/`runIf`, `cond ? it : it.skip`, or a bare `if (win32) return;`).
Never skip on win32; make the test portable. Existing sites are grandfathered in
`.posix-guard-baseline.json` as per-file, per-rule **counts** (never line
numbers). Unlike the size ratchets it is **growth-only**: a count above baseline
fails, and a count below it (or a deleted file) passes with a hint, so lanes
removing violations never have to touch the baseline. Regenerate with
`pnpm audit:posix:update` (refuses growth without `--allow-growth --reason "<why>"`);
`pnpm audit:posix:list` prints every current site.

### Long-comment prefix convention

Any source-comment block ≥15 contiguous lines must open with one of:

- `// Invariant:` — ordering constraint, protocol rule, externally-governed semantic. Stays inline.
- `// Contract:` — param/return/throws semantics, type-narrowing rationale. Stays inline.
- `// History:` — root-cause, decision log, postmortem. Migrates to `docs/<area>.md` on next touch; leave a ≤5-line summary + link in place.

Choose the prefix before writing the body. When in doubt between `Invariant:` and `History:`, use `Invariant:` — false-shrink is a regression. JSDoc may carry the prefix in the body (`* Invariant: …`).

**There is no linter gate for this** — `tsc` and CI will not catch a missing prefix, so it is review-enforced and self-checked. Audit recipe for untagged ≥15-line `//` blocks (approximate; a blank line splits a block):

```bash
grep -rn --include='*.ts' '^[[:space:]]*//' src/ \
  | awk -F: '
      {
        f=$1; cur=int($2)
        if (prev_f != f || cur != prev_l + 1) { run=0; tagged=0 }
        prev_f=f; prev_l=cur
        if ($0 ~ /\/\/ (Invariant|Contract|History):/) { tagged=1; next }
        if (tagged) next
        run++
        if (run == 15) { print f ":" (cur-14) ": untagged ≥15-line block"; run=0 }
      }'
```

### Ordered-operation sequences

Before generating sequences of terminal writes, async state mutations, or persistence-then-UI ops:

- Name the external constraint governing the sequence (protocol / event-loop boundary / semantic invariant).
- Emit the constraint as a code comment, not just in reasoning.
- TUI code: write teardown **before** setup in the source file so the inverse is never orphaned.
- No optimistic rendering — never emit a UI update before its dependent write has a confirmed result, unless explicitly specified.

Source: pattern card `agents-fail-ordered-sequences-when-constraint-is-externally-governed` (charged).
