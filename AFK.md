# agent-afk

## What This Is

Standalone TypeScript CLI + daemon + Telegram bot built on `@anthropic-ai/sdk`. Binary: `afk`. Node `^22.22.2 || ^24.15.0 || >=26.0.0`, pnpm 11 only (pinned via `package.json#packageManager`). Releases via `pnpm release patch|minor|major` from `main` (`scripts/release.mjs`; CI publishes on tag push).

## Commands

```bash
pnpm install                                       # pnpm exclusively
pnpm build                                         # tsc + web UI (dashboard/) + copy *.md prompts → dist/
pnpm test                                          # vitest run (all)
pnpm test src/agent/session.test.ts                # single file (NO --; pnpm 10+ drops args after --)
pnpm test src/agent/session.test.ts -t "sends a message"   # single test by name
pnpm test:coverage                                 # CI gate with coverage floors
pnpm test:pty                                      # PTY suite (separate config, own CI job)
pnpm lint                                          # tsc --noEmit (strict)
pnpm lint:tests:check                             # CI gate: error-count ratchet

pnpm audit:sdk:check                               # CI gate: unlocked SDK symbols
pnpm audit:env:check                               # CI gate: no raw process.env reads
pnpm scan:env:check                                # CI gate: env-registry in sync
pnpm audit:chalk:check                             # CI gate: no raw chalk.<color>
pnpm audit:filesize:check                          # 350-code-line ceiling
pnpm audit:filesize:update                         # regenerate baseline after a split
pnpm audit:funcsize:check                          # 200-line function ceiling
pnpm audit:funcsize:update                         # regenerate function baseline
pnpm audit:module-state:check                      # no duplicated singletons across siblings
pnpm audit:clones:check                            # no NEW copy-paste clones vs origin/main
pnpm fix:pins:check                                # SHA-256 pins for vendored agents + bundled skills
pnpm audit:deps                                    # pnpm audit --audit-level=critical --prod
pnpm check:audits                                  # run all CI audit gates locally
pnpm regen:generated                               # resolve all generated-file merge conflicts
pnpm release                                       # release pipeline (scripts/release.mjs)
```

Every gate above plus `pnpm lint` and `pnpm build` runs on each PR — run locally before pushing.

### Running

```bash
pnpm dev                                     # tsx watch — live-reloads CLI
afk chat "hi" / afk interactive / afk daemon # one-shot / REPL / cron headless
pnpm telegram:start                          # Telegram bot
```

### Pre-push hook

`pnpm install` installs a pre-push hook running `pnpm check:audits`. Bypass: `git push --no-verify`.

### Observability & Introspection

Quick orientation: `/where` in the REPL shows branch, cwd, session identity, and pointers to deeper tools at a glance.

**Witness traces** — every session writes `$AFK_HOME/state/witness/<sessionLabel>/trace.jsonl`:

```bash
afk trace list                       # recent sessions by mtime
afk trace show [session]             # pretty-print trace (--all, -n 40, --json)
afk trace show --results             # include full tool outputs from journal
afk trace export-otlp [session]      # convert to OpenTelemetry spans
```

**Witness search** — query across sessions:

```bash
afk witness read [session]           # read/filter events by kind, tool, errors-only
afk witness search "rate limit"      # text-search across recent sessions (--since, --kind)
```

**Runtime state** (agent tool `get_runtime_state`; human via `/debug`, `/tools`, `/info`):

| View | What it shows |
|------|---------------|
| `self` | sessionId, surface, depth, cwd, model, permissionMode |
| `tools` | enabled tool names, MCP servers (name + tool count), failed servers |
| `subagents` | active foreground handles, background jobs (id, status, label) |
| `workspace` | branch, headSha, dirty, dirtyCount, remoteUrl |
| `hooks` | merged disk hook config (opt-in, excluded from `all`) |
| `all` | union of self/tools/subagents/workspace + usage + clock |

For trace internals, journal sync points, witness retention rules: `memory_search "trace internals"` or read `docs/`.

### Subagent tool-round budget

Budget unit is tool-use **rounds** (5 parallel calls = 1 round). Default: 50/fork; `0` = unbounded. Cap triggers wind-down, not kill. Spec: `docs/subagent-tool-budget.md`.

## Architecture

Key layers under `src/`:

| Path | Purpose |
|------|---------|
| `src/agent/` | Provider-agnostic session harness. `AgentSession` → `ModelProvider` via `providerForModel()`. |
| `src/agent/providers/anthropic-direct/` | `@anthropic-ai/sdk` Messages API. Default for `claude-*`. |
| `src/agent/providers/openai-compatible/` | OpenAI Chat Completions + compatible endpoints. Default for `gpt-*`, `o1*`, `o3*`, `o4*`, local shims. |
| `src/cli/` | Commander terminal surface. REPL: `commands/interactive/`. Slash commands: `src/cli/slash/`. |
| `src/telegram/` | Telegraf bot, per-chat sessions, allowlist. |
| `src/skills/` | Headless skill mirrors. Vendored agents in `_agents/`. |
| `src/config/` | `env.ts` = canonical `process.env` read-point (`ENV_REGISTRY`). |
| `src/paths.ts` | All AFK path helpers. Never hand-join `~/.afk/` paths. |
| `src/browser/` | Playwright browser-control tools. |
| `src/http-client/` | `web_scrape` pipeline. |
| `src/remote/` | `remote_agent` over SSH. Docs: `docs/remote-dispatch.md`. |
| `src/utils/` | Leaf helpers. No upward imports. |
| `website/` | Next.js docs site (separate package). |

For cross-cutting subsystems (hooks, effect ledger, subagent manager, abort graph, MCP, plugins, peer messaging, usage awareness): `memory_search "<subsystem>"` or read `docs/`.

## Conventions

- **`tsconfig.json` is maximally strict**: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`.
- `AgentSession` constructor is **synchronous**; SDK lifecycle runs async via `initSdkLifecycle()`.
- **SDK dependency tracking**: every `@anthropic-ai/sdk` import locked in `.sdk-dependency.lock.json`. Run `pnpm audit:sdk:update-lock` after adding one.
- **Three mandatory indirections** (CI-enforced): Env vars via `src/config/env.ts`, styling via `src/cli/palette.ts`, paths via `src/paths.ts`. Never `process.env`, `chalk.<color>()`, or hand-join `~/.afk/`.
- **No model SDK imported outside `src/agent/providers/`** — the rest imports only the SDK's `ContentBlockParam` *type*.
- Build copies `*.md` prompts from `src/` to `dist/` via `scripts/copy-prompts.js`.
- Vendored agents (`src/skills/_agents/`) and bundled skills (`src/bundled-plugins/`) are SHA-256 pinned. Run `pnpm fix:pins` after intentional edits.
- Two instruction files: this file (repo-specific), `AGENTS.md` (generic protocol). No tracked `CLAUDE.md`.

### The 350-code-line ceiling

No source file under `src/` or `scripts/` exceeds 350 code lines (comments/blanks excluded). At the ceiling, extract one concern into `src/foo/bar.<concern>.ts`; the original never moves. `.filesize-baseline.json` is a one-way ratchet; regenerate with `pnpm audit:filesize:update` (never hand-edit `loc`; `--allow-growth --reason` for growth). `pnpm regen:generated` resolves conflicts. State must stay singular: `pnpm audit:module-state:check`. Full protocol: `docs/file-size-ceiling.md`.

### The 200-line function ceiling

CI-blocking via `pnpm audit:funcsize:check`. At the ceiling, extract a **named helper taking explicit parameters** (not a closure). `.funcsize-baseline.json` ratchet; regenerate with `pnpm audit:funcsize:update`. `pnpm audit:funcsize:list` ranks worst.

### POSIX-assumption guard

`tests/posix-guard.test.ts` enforces static rules every PR: use `resolveShell()` not `/bin/sh`; `path.join(os.tmpdir(), ...)` not `/`-rooted literals; `path.posix.*` for POSIX paths; never skip tests on win32. Baseline: `.posix-guard-baseline.json` (growth-only ratchet). `pnpm audit:posix:update`.

### Long-comment prefix convention

Comment blocks ≥15 lines must open with `// Invariant:`, `// Contract:`, or `// History:`. Review-enforced, no linter gate.

### Ordered-operation sequences

Name the external constraint, emit it as a code comment, write teardown before setup in TUI code, no optimistic rendering.
