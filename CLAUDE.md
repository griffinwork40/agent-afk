# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

agent-afk is a standalone TypeScript CLI + daemon + Telegram bot built on `@anthropic-ai/sdk` (plus the `openai` package for OpenAI-compatible endpoints). It runs **outside** Claude Code as its own process. The binary is `afk`. Node ≥22, pnpm-only.

## Commands

```bash
pnpm install              # Use pnpm exclusively — lockfile is pnpm-specific
pnpm build                # tsc + copies *.md prompt files into dist/
pnpm test                 # vitest run (all tests)
pnpm test src/agent/session.test.ts               # single file — NO `--`; pnpm 10 drops args after it and runs ALL files
pnpm test src/agent/session.test.ts -t "sends a message"   # single test by name: scope to a file first, then filter
pnpm test:watch           # vitest watch mode
pnpm test:coverage        # CI gate — enforces coverage floors that plain `pnpm test` does not
pnpm test:pty             # PTY suite, separate config (vitest.pty.config.ts) and its own CI job
pnpm lint                 # tsc --noEmit (strict, no unused locals/params)

pnpm audit:sdk            # regenerate SDK dependency snapshot (docs/sdk-dependency.md)
pnpm audit:sdk:check      # CI gate — fails on unlocked new symbols or kind changes
pnpm audit:sdk:update-lock  # add new symbols to .sdk-dependency.lock.json (edit reason field before committing)
pnpm audit:env:check      # CI gate — no raw process.env reads outside src/config/env.ts
pnpm scan:env:check       # CI gate — docs/env-registry.{json,md} in sync with src/config/env.ts
pnpm audit:chalk:check    # CI gate — no raw chalk.<color> outside src/cli/palette.ts (--list locates sites)
pnpm audit:filesize:check # CI gate — 350-line source ceiling, ratcheted against .filesize-baseline.json
pnpm audit:filesize:update  # regenerate the baseline after a split (never hand-edit loc values)
pnpm audit:funcsize:check # CI gate — 200-line function ceiling, ratcheted against .funcsize-baseline.json
pnpm audit:funcsize:update  # regenerate the function baseline after an extraction
pnpm audit:module-state:check  # CI gate — no module-scope singleton/process.on duplicated across a sibling family
pnpm fix:pins:check       # CI gate — SHA-256 pins for vendored agents + bundled skills (pnpm fix:pins rewrites)
pnpm audit:deps           # CI gate — pnpm audit --audit-level=critical --prod
```

Every gate above, plus `pnpm lint` and `pnpm build`, runs on each PR (`.github/workflows/ci.yml`). Run them locally before pushing rather than after CI reddens.

### Running

```bash
pnpm dev                         # tsx watch — live-reloads the CLI
afk chat "hello"                 # one-shot message
afk interactive                  # REPL mode (aliases: afk i)
afk daemon                       # cron-based headless runner
pnpm telegram:start              # Telegram bot (managed via scripts/telegram-manager.sh)
```

## Architecture

### Three Layers

1. **`src/agent/`** — Provider-agnostic session harness. `AgentSession` is the single runtime entry point; it delegates to a `ModelProvider` selected by model family (`providerForModel()`). The two bundled providers live in `src/agent/providers/`:
   - `anthropic-direct/` — wraps `@anthropic-ai/sdk` Messages API directly (default for `claude-*`, `opus`, `sonnet`, `haiku`). `'anthropic'` is a silent alias for this provider.
   - `openai-compatible/` — talks directly to OpenAI's Chat Completions API, and to any compatible endpoint via `baseURL`. Default for `gpt-*`, `o1*`, `o3*`, `o4*`, `codex-*`, **and** HuggingFace-style `org/model` ids (`mlx-community/…`, `Qwen/…`) served by local OpenAI-shim runners (MLX, llama.cpp, vLLM, ollama-openai). It replaced a `@openai/codex-sdk`-backed `openai-codex` provider that no longer exists; `'openai-codex'` survives only as a deprecated alias, and the codex SDK is **not** a dependency.

   Both emit a normalized `ProviderEvent` stream consumed by `src/agent/session/stream-consumer.ts`. No model SDK is imported for runtime use outside `src/agent/providers/` — the rest of the tree imports only the SDK's `ContentBlockParam` *type*.

2. **`src/cli/`** — Terminal surface. Commander-based with commands under `src/cli/commands/`. The interactive REPL (`commands/interactive/`) has its own lifecycle: bootstrap → REPL loop → turn handler → markdown streaming → cleanup. Slash commands (`src/cli/slash/`) register via a Levenshtein-hint dispatcher.

3. **`src/telegram/`** — Telegram surface. Telegraf-based bot with per-chat session management and an allowlist gate (`AFK_TELEGRAM_ALLOWED_CHAT_IDS`).

Supporting modules outside those three layers: `src/config/` (`env.ts` is the **canonical** `process.env` read-point), `src/paths.ts` (all AFK path resolution), `src/browser/` (Playwright browser-control tools + witness capture + domain policy), `src/web/` (`web_scrape`: fetch → Readability → markdown, headless-render fallback, Exa search), `src/insights/` (`afk insights` report — import via the `index.ts` barrel, not sub-paths), `src/improve/` (telemetry scan → eval-gen → eval-run → propose), `src/service/` (macOS LaunchAgent install/manage), `src/bundled-plugins/` (plugins shipped with the package), `src/utils/` (leaf helpers; nothing here imports upward), and `website/` (Next.js docs site — separate package, npm-locked, typechecked and built in CI).

### Cross-Cutting Subsystems

- **Hooks** (`src/agent/hooks.ts`, `hook-registry.ts`) — Lifecycle hooks (SessionStart/End, SubagentStart/Stop, PreToolUse/PostToolUse). Handlers run sequentially; `decision: 'block'` short-circuits. SubagentStop supports `injectContext` for parent-session context injection.
- **SubagentManager** (`src/agent/subagent.ts`) — Forks child `AgentSession` instances with permission bubbling, transitive abort via `AbortGraph`, and optional Zod output schemas.
- **AbortGraph** (`src/agent/abort-graph.ts`) — Tree of `AbortController`s. Parent abort cascades down; child abort notifies up (never auto-aborts parent). Abort always takes precedence over hook decisions.
- **Elicitation Router** (`src/agent/elicitation-router.ts`) — Module-scope handler for SDK elicitation requests, bridging to REPL/Telegram/iMessage surfaces.
- **Plugins** (`src/agent/plugins-scanner.ts`, `src/agent/plugins/`) — `scanLocalPlugins()` scans `~/.afk/plugins/` at session construction; discovered skills are bridged into the tool surface by `src/agent/tools/skill-bridge.ts`. Plugins are never handed to a model SDK — there is no SDK-side plugin concept. Includes install, remove, update, and git-based source support.
- **MCP client** (`src/agent/mcp/`) — Wraps `@modelcontextprotocol/sdk`. `McpManager.fromConfig()` connects every server from `loadMcpConfig()`, layered lowest→highest: plugin-contributed `<plugin>/.claude-plugin/mcp.json` → `~/.afk/config/mcp.json` → `<cwd>/.mcp.json` → `--mcp-config <path>`. Higher layer wins on name conflict, displaced source surfaced as a warning. Transports: stdio, streamable-HTTP, SSE fallback, OAuth. Tools bridge as `mcp__<server>__<tool>` and are read fresh per-query, so `notifications/tools/list_changed` refreshes land without a session restart. Sampling capability is deliberately not advertised — it removes the "stub or hang" footgun. `/mcp` lists servers; `/mcp auth` surfaces pending OAuth URLs.

### Skills System

Skills under `src/skills/` mirror the plugin surface's orchestration skills for headless invocation. Each skill has a `prompts/` directory with markdown prompts loaded at runtime by `src/skills/_lib/prompt-loader.ts`. The build step (`scripts/copy-prompts.js`) copies all `*.md` files from `src/` into `dist/` so prompts are available in the built output.

Vendored agents (`src/skills/_agents/`) are byte-equal copies of agent definitions. `src/skills/_agents/vendored.test.ts` enforces drift detection.

### User-Scope State

All AFK state lives under `~/.afk/` (never `~/.claude/`), and every path is resolved through `src/paths.ts` — never hand-join one. Two scopes:

```
~/.afk/                 # user-scope ($AFK_HOME)
  config/     afk.env, afk.config.json, mcp.json
  state/                ($AFK_STATE_DIR overrides this tier)
    sessions/    session-store sidecars (tool ARGS live here, in events.jsonl)
    todos/       todo-panel data
    transcripts/ autosaved REPL session transcripts
    daemon/      per-instance daemon state
    witness/     per-session trace.jsonl — see Observability below
  plugins/    local plugin installs
  logs/
  cache/
<cwd>/.afk/             # project-scope: per-project skills + plugins, auto-discovered
```

All AFK telemetry and briefs write to `~/.afk/agent-framework/` via `paths.ts`. The plugin surface writes to `~/.claude/agent-framework/` independently — no shared state between surfaces.

### Observability / tracing

Every session writes a **witness trace** — the durable chronological record of what the agent actually did (tool calls with timing, result bytes, ok/err; subagent lifecycle; session phases). Reach for this first when reconstructing a past run, not the transcript (prose only) and not the service logs (other processes).

```bash
afk trace show [<session>]  # pretty-print a trace (default "latest"); --all includes low-signal
                            # events, -n 40 limits to last N, --json emits raw NDJSON for jq
afk trace list              # sessions having a trace, newest first (-n/--max <N>, default 20)
```

Writer + reader live in `src/agent/trace/`; the CLI is `src/cli/commands/trace.ts`. **Two things the trace does not answer**: tool *args* (those are in `state/sessions/<id>/events.jsonl` — the trace carries only `inputBytes`) and raw tool *output* (never recorded durably, only `resultBytes`).

One residual bug worth recognizing: a parent session ending mid-wave seals over live children and silently drops their terminal rows, so ~3% of dispatched subagents have no recorded fate (~8% in daemon/cron parallel waves vs ~1% interactive). Detector: an unmatched `started` in a trace that *contains* `session_sealed` — not "a `started` is the file's last line", which misses it because the seal is written afterward.

### Subagent tool-round budget

The unit of the budget cap is **tool-use rounds**, not tool calls — 5 parallel calls in one reply consume 1 round, not 5. Default ceiling: **50 rounds per fork**; `0` = unbounded. Hitting the cap triggers a wind-down round (tools stripped from the next reply) rather than a kill, so the child returns partial work instead of dying mid-sentence. Each child is told its own budget at dispatch via the preamble injected by `src/agent/session/budget-preamble.ts`. Full history and rationale: `docs/subagent-tool-budget.md`.

## SDK Dependency Tracking

Every import from `@anthropic-ai/sdk` is tracked. `.sdk-dependency.lock.json` is the allowlist — CI fails when a new symbol appears without a lock entry. After adding a new SDK import: `pnpm audit:sdk:update-lock`, then edit the new entry's `reason` field before committing.

## Key Conventions

- `tsconfig.json` is maximally strict: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`. All code must pass `tsc --noEmit`.
- The system prompt is the framework base (`prompts/system-prompt.md`) with the operator overlay appended, composed by `resolveBaseSystemPrompt()` and sent to the Messages API as a raw string. No SDK preset (e.g. Agent SDK's `claude_code`) is loaded — agent-afk talks directly to the Messages / Chat Completions APIs, not the Agent SDK.
- The `AgentSession` constructor is synchronous; the SDK lifecycle (provider query setup, session init) runs asynchronously via `initSdkLifecycle()` and surfaces through the provider event stream.
- DAG executor (`src/agent/dag.ts`) is a Kahn-layer parallel executor with per-node AbortControllers, fail-fast semantics, transitive skip propagation, node-level timeouts, and listener-leak prevention. ~266 LOC, fully implemented.
- **Three mandatory indirections**, each with a canonical read/write point and a CI gate. Env vars: never read `process.env` in new code — use the typed `env` object and register new vars in `ENV_REGISTRY` (`src/config/env.ts`; `audit:env:check` + `scan:env:check`). A handful of files carry a documented whole-file exemption in `ALLOWED_FILES` (`scripts/audit-env-access.ts`); adding an entry there is a last resort, not the way around the gate. Styling: never call `chalk.<color>()` — use the semantic palette (`src/cli/palette.ts`; `audit:chalk:check`, which landed after ~180 raw sites crept back). Paths: never hand-join anything under `~/.afk/` — use `src/paths.ts`.
- Vendored agents (`src/skills/_agents/`) and bundled skills (`src/bundled-plugins/`) are SHA-256 pinned in their test files. Editing either on purpose means running `pnpm fix:pins`; an unexplained pin failure means an edit you did not intend.

### The 350-line ceiling

No source file under `src/` or `scripts/` exceeds **350 raw lines** (`wc -l`
semantics). Gate: `pnpm audit:filesize:check` (`scripts/check-file-size.ts`), warn
band 316–350. Tests, `__fixtures__`, `__test-utils__`, `.d.ts` are out of scope.

The reason is agent-context economics, not aesthetics: an oversized file costs an
agent most of a working context just to establish what it may safely touch, and
the failure mode is silent — the agent edits from a partial read. So at the
ceiling you pull **one whole concern** into a sibling (`bar.ts` →
`bar.<concern>.ts`), the original **never moves** and keeps its exact public
surface, and no importer is rewritten. A file already inside its own directory
gets plain-named siblings in that directory.

`.filesize-baseline.json` grandfathers the 138 pre-existing violators as a
**one-way ratchet**: it fails on a new violator, on a baselined file that *grows*,
on a baselined file that now fits (remove it), and on a baselined path that no
longer exists. Regenerate with `pnpm audit:filesize:update` — never hand-edit
`loc`; `reason`/`permanent` are yours and survive regeneration. The file is
`-merge` in `.gitattributes`: resolve conflicts by regenerating, not by
editing markers.

**Do not delete documentation to satisfy this gate.** The originally-over files
averaged 45.5% comment+blank, and this repo *mandates* long
`Invariant:`/`Contract:`/`History:` blocks. The lever is that JSDoc travels with
its declaration — extract a declaration group and its docs move with it. Never
delete, reflow, or condense a comment for line count, and never reclassify an
`Invariant:`/`Contract:` block as `History:` to make it migratable; false-shrink
is a regression.

Two companion invariants: `pnpm audit:module-state:check` fails when the same
module-scope singleton or `process.on` registration is declared in two files of
one sibling family (a split that forks state compiles and passes tests while
silently diverging at runtime), and an extracted sibling must be reachable from
one of the three esbuild entrypoints or `build:dist` tree-shakes it with no CI
signal. Campaign plan: `docs/file-size-ceiling.md`.

### The 200-line function ceiling

`pnpm audit:funcsize:check` (`scripts/check-function-size.ts`) fails when any one
function under `src/` or `scripts/` exceeds **200 lines**. This is a separate gate
from the file ceiling and **neither implies the other**. File size measures how
much you must *read* to establish edit safety; function size measures how much you
must *hold in mind* to change one behaviour. A flat 900-line registry is a big file
with no big function; a 700-line function can hide in a file that passes 350 only
because siblings were extracted around it. Live proof is #919 — #829 shrank
`subagent.ts` and closed while `forkSubagent` itself never changed, and it has
since grown to 586 lines. The file gate scored that as progress.

Ceiling of 200 was measured, not guessed: across 4,388 functions (median 10, p99
229) it grandfathers 54 entries — 1.2%, versus the file baseline's 15.6% — which is
what keeps `.funcsize-baseline.json` short enough to read and therefore honest.
Same five-mode ratchet, same `-merge` gitattribute, same never-hand-edit-`loc`
rule; regenerate with `pnpm audit:funcsize:update`, rank offenders with
`pnpm audit:funcsize:list`.

Measurement is AST-based and **excludes JSDoc**, unlike the file metric which
counts comments deliberately. The asymmetry is the point: a file relieves its
ceiling by extraction and its docs travel with the declaration, but a function
cannot be split from its own doc comment, so counting JSDoc there would create
undiluted pressure to delete documentation. At the ceiling, extract a named helper
with **explicit parameters** — a closure over enclosing locals moves lines without
reducing what must be held in mind. Reconciliation with the #831/#832 triage that
proposed this gate: `docs/file-size-ceiling.md`.

### Long-comment prefix convention

Any source-comment block ≥15 contiguous lines must lead with exactly one of:

| Prefix | Use for | Lifecycle |
|--------|---------|-----------|
| `// Invariant:` | Ordering constraint, protocol rule, ANSI/library quirk, externally-governed semantic | Stays inline permanently |
| `// Contract:` | Param/return/throws semantics, union-variant meanings, type-narrowing rationale | Stays inline permanently |
| `// History:` | Root-cause analysis, decision log, bug postmortem, why-we-chose-X | Migrates to `docs/<area>.md#anchor` on next touch; leave a ≤5-line summary + link in place |

**Rationale**: comments adjacent to code rot less than docs, but `History:` content is cold-path and accumulates noise. The prefix makes intent greppable for hygiene passes and forces author to declare category at write-time. JSDoc blocks can carry the prefix inside the comment body — `* Invariant: …` is fine.

**Enforcement**: no linter gate. Review-enforced on new long blocks; existing blocks migrate on-touch. False-shrink (collapsing an `Invariant:` as if it were `History:`) is a regression — when in doubt, classify as `Invariant:` and leave inline.

**Audit recipe** — find untagged long-comment blocks (approximate; may miss blocks broken by blank lines):

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

### System Prompt Discovery

The base system prompt is **layered**: the framework prompt (`prompts/system-prompt.md`, inlined at publish-build) is the unconditional foundation, and the resolved operator overlay is **appended** on top beneath an `# Operator configuration` header — never a replacement. `resolveBaseSystemPrompt()` (`src/cli/shared-helpers.ts`) does the layering for every top-level surface (chat, REPL, Telegram, farm).

`loadConfig()` resolves the **operator overlay** across three tiers (highest wins); `loadConfig().systemPrompt` is that overlay alone:

| Tier | Overlay source | `loadConfig().systemPromptSource` value |
|------|--------|---------------------------|
| 1 | `AFK_SYSTEM_PROMPT` env var | `"env:AFK_SYSTEM_PROMPT"` |
| 2 | `afk.config.json` (`cwd` → `~/.afk/config/` → legacy) | `"file:<abs path>"` |
| 3 | `AFK.md` (`cwd` **+** `$AFK_HOME/`, additive) | `"afk-md:<abs>"` or `"afk-md:<user-abs>+afk-md:<project-abs>"` |
| — | None | `systemPromptSource` is `undefined` |

`AFK.md` is plain Markdown with no frontmatter; empty or whitespace-only files count as absent per-file. The framework base is always present regardless of overlay tier.

Tier 3 is **additive, not exclusive** — this is a recent change and the easiest thing to get wrong. `loadAfkMd()` (`src/cli/config/afk-md-tier.ts`) reads *both* `$AFK_HOME/AFK.md` (user-scope) and `<cwd>/AFK.md` (project-scope) when both are non-empty and concatenates them — user-scope first, then project-scope under a `## Project configuration … takes precedence on conflict` header — rather than letting the project file silently shadow the personal one. Dedup runs through `realpath`, so a symlinked pair is not double-counted. When only one tier resolves (the common case) the output is byte-identical to a single-tier read: no header, no behavior change.

`--dump-prompt` reports the composed `systemPromptSource` (`"framework"`, `"framework+afk-md:<path>"`, `"framework+afk-md:<user>+afk-md:<project>"`, …) and the full text in `options.system`; the composed prompt is never forwarded to the SDK as a preset. Every overlay appends — there is currently no full-replace escape hatch (a future `AFK_BASE_PROMPT=0` would add one).

## Ordered-operation sequences

Before generating any sequence of terminal writes, async state mutations, or persistence-then-UI operations:

- Name the external constraint governing the sequence (protocol / event-loop boundary / semantic invariant).
- Emit the constraint as a comment in the code, not just in reasoning.
- For TUI code: always write teardown before setup in the source file, so the inverse is never orphaned.
- Never emit a UI update before the write it depends on has a confirmed result (no optimistic rendering unless explicitly specified).

Source: pattern card `agents-fail-ordered-sequences-when-constraint-is-externally-governed` (status: charged). Failure shape: agent reads syntactically adjacent operations, infers free composability, emits sequentially incorrect code because the governing constraint is not locally visible at the call sites.
