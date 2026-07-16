# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

agent-afk is a standalone TypeScript CLI + daemon + Telegram bot that uses `@anthropic-ai/sdk` (and optionally `@openai/codex-sdk`). It runs **outside** Claude Code as its own process. The binary is `afk`.

## Commands

```bash
pnpm install              # Use pnpm exclusively — lockfile is pnpm-specific
pnpm build                # tsc + copies *.md prompt files into dist/
pnpm test                 # vitest run (all tests)
pnpm test src/agent/session.test.ts               # single test file (unit tests co-located with src)
pnpm test -t "sends a message"                     # single test by name
pnpm test:watch           # vitest watch mode
pnpm lint                 # tsc --noEmit (strict, no unused locals/params)

pnpm audit:sdk            # regenerate SDK dependency snapshot (docs/sdk-dependency.md)
pnpm audit:sdk:check      # CI gate — fails on unlocked new symbols or kind changes
pnpm audit:sdk:update-lock  # add new symbols to .sdk-dependency.lock.json (edit reason field before committing)
```

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
   - `openai-codex.ts` — wraps `@openai/codex-sdk` (for `gpt-*`, `o1*`, `o3*`, `o4*`, `codex-*`).

   Both emit a normalized `ProviderEvent` stream consumed by `src/agent/session/stream-consumer.ts`. Nothing outside `src/agent/providers/` imports from any model SDK directly.

2. **`src/cli/`** — Terminal surface. Commander-based with commands under `src/cli/commands/`. The interactive REPL (`commands/interactive/`) has its own lifecycle: bootstrap → REPL loop → turn handler → markdown streaming → cleanup. Slash commands (`src/cli/slash/`) register via a Levenshtein-hint dispatcher.

3. **`src/telegram/`** — Telegram surface. Telegraf-based bot with per-chat session management and an allowlist gate (`AFK_TELEGRAM_ALLOWED_CHAT_IDS`).

### Cross-Cutting Subsystems

- **Hooks** (`src/agent/hooks.ts`, `hook-registry.ts`) — Lifecycle hooks (SessionStart/End, SubagentStart/Stop, PreToolUse/PostToolUse). Handlers run sequentially; `decision: 'block'` short-circuits. SubagentStop supports `injectContext` for parent-session context injection.
- **SubagentManager** (`src/agent/subagent.ts`) — Forks child `AgentSession` instances with permission bubbling, transitive abort via `AbortGraph`, and optional Zod output schemas.
- **AbortGraph** (`src/agent/abort-graph.ts`) — Tree of `AbortController`s. Parent abort cascades down; child abort notifies up (never auto-aborts parent). Abort always takes precedence over hook decisions.
- **Elicitation Router** (`src/agent/elicitation-router.ts`) — Module-scope handler for SDK elicitation requests, bridging to REPL/Telegram/iMessage surfaces.
- **Plugins** (`src/agent/plugins-scanner.ts`, `src/agent/plugins/`) — Scans `~/.afk/plugins/` at session construction and passes discovered plugins as local entries to the SDK. Includes install, remove, update, and git-based source support.

### Skills System

Skills under `src/skills/` mirror the plugin surface's orchestration skills for headless invocation. Each skill has a `prompts/` directory with markdown prompts loaded at runtime by `src/skills/_lib/prompt-loader.ts`. The build step (`scripts/copy-prompts.js`) copies all `*.md` files from `src/` into `dist/` so prompts are available in the built output.

Vendored agents (`src/skills/_agents/`) are byte-equal copies of agent definitions. `src/skills/_agents/vendored.test.ts` enforces drift detection.

### User-Scope State

All AFK state lives under `~/.afk/` (never `~/.claude/`). AFK resolves user-scope state directly from that home. Layout:

```
~/.afk/
  config/     afk.env, afk.config.json
  state/                ($AFK_STATE_DIR overrides this tier)
    sessions/    session-store sidecars
    todos/       todo-panel data
    transcripts/ autosaved REPL session transcripts
    daemon/      per-instance daemon state
  plugins/    local plugin installs
  logs/
  cache/
```

All AFK telemetry and briefs write to `~/.afk/agent-framework/` via `paths.ts`. The plugin surface writes to `~/.claude/agent-framework/` independently — no shared state between surfaces.

## SDK Dependency Tracking

Every import from `@anthropic-ai/sdk` is tracked. `.sdk-dependency.lock.json` is the allowlist — CI fails when a new symbol appears without a lock entry. After adding a new SDK import: `pnpm audit:sdk:update-lock`, then edit the new entry's `reason` field before committing.

## Key Conventions

- `tsconfig.json` is maximally strict: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`. All code must pass `tsc --noEmit`.
- The system prompt for agent-afk sessions is a raw string loaded from config or a file, sent to the Messages API as-is. No SDK preset (e.g. Agent SDK's `claude_code`) is loaded — agent-afk talks directly to `@anthropic-ai/sdk` / `@openai/codex-sdk`, not the Agent SDK.
- The `AgentSession` constructor is synchronous; the SDK lifecycle (provider query setup, session init) runs asynchronously via `initSdkLifecycle()` and surfaces through the provider event stream.
- DAG executor (`src/agent/dag.ts`) is a Kahn-layer parallel executor with per-node AbortControllers, fail-fast semantics, transitive skip propagation, node-level timeouts, and listener-leak prevention. ~266 LOC, fully implemented.

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
| 3 | `AFK.md` (`cwd` → `$AFK_HOME/`) | `"afk-md:<abs path>"` |
| — | None | `systemPromptSource` is `undefined` |

`AFK.md` is plain Markdown with no frontmatter. Empty or whitespace-only files are treated as absent. The framework base is always present regardless of overlay tier. `--dump-prompt` reports a composed `systemPromptSource` (`"framework"`, `"framework+afk-md:<path>"`, …) and the full text in `options.system`; the composed prompt is never forwarded to the SDK as a preset. Every overlay appends — there is currently no full-replace escape hatch (a future `AFK_BASE_PROMPT=0` would add one).

## Ordered-operation sequences

Before generating any sequence of terminal writes, async state mutations, or persistence-then-UI operations:

- Name the external constraint governing the sequence (protocol / event-loop boundary / semantic invariant).
- Emit the constraint as a comment in the code, not just in reasoning.
- For TUI code: always write teardown before setup in the source file, so the inverse is never orphaned.
- Never emit a UI update before the write it depends on has a confirmed result (no optimistic rendering unless explicitly specified).

Source: pattern card `agents-fail-ordered-sequences-when-constraint-is-externally-governed` (status: charged). Failure shape: agent reads syntactically adjacent operations, infers free composability, emits sequentially incorrect code because the governing constraint is not locally visible at the call sites.
