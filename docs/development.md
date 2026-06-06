# Development

Internal reference for working on `agent-afk` itself — building, testing, releasing, and the conventions enforced across the codebase. The npm package readers don't see this file; it's for collaborators and future-you.

## Prerequisites

- **Node.js ≥ 22.0.0** (enforced by `package.json#engines`). Node 20 is EOL and `better-sqlite3` ≥ 12.10 ships no prebuilt binaries for it — installs on Node 20 fall back to a node-gyp source build, which fails on machines without Python/build tools.
- **pnpm** — the lockfile is pnpm-specific. `npm install` will desync it.
  - Fast path: `corepack enable` (bundled with Node ≥ 16.9), then use `pnpm` directly.
  - Or globally: `npm install -g pnpm@latest`.
- A valid Anthropic API key, or an OpenAI key for the Codex provider.

## Setup

```bash
git clone <repo>
cd agent-afk
corepack enable          # optional, pins pnpm to the repo's version
pnpm install
pnpm build
```

`pnpm build` runs `tsc` and then `scripts/copy-prompts.js`, which copies every `src/**/*.md` file into `dist/` at matching relative paths. Skills read their prompts via `readFileSync` at import time, so those markdown files must live next to the compiled `.js` output.

After build, `pnpm start` and friends invoke `node dist/cli/index.js` (the `tsc` tree output) directly. The published binary is different — see [Releasing](#releasing) below.

## Scripts

```bash
# Build / dev
pnpm build                  # tsc && node scripts/copy-prompts.js
pnpm build:dist             # esbuild bundle into dist/ for release artifacts
pnpm dev                    # tsx watch src/cli/index.ts
pnpm start                  # node dist/cli/index.js
pnpm start:chat             # shortcut for `chat`
pnpm start:interactive      # shortcut for `interactive`
pnpm start:status           # shortcut for `status`
pnpm clean                  # rm -rf dist

# Testing
pnpm test                   # vitest run (all)
pnpm test:coverage          # with coverage report
pnpm test:watch             # watch mode
pnpm lint                   # tsc --noEmit (type-check only)

# SDK dependency audit
pnpm audit:sdk              # regenerate docs/sdk-dependency.md
pnpm audit:sdk:check        # CI gate: fail on unlocked SDK symbols
pnpm audit:sdk:update-lock  # add new symbols → .sdk-dependency.lock.json

# Telegram daemon
pnpm telegram               # foreground
pnpm telegram:setup         # interactive setup wizard
pnpm telegram:start         # background service
pnpm telegram:stop
pnpm telegram:status
pnpm telegram:restart
pnpm telegram:logs

# Release
pnpm release                # scripts/release.mjs — version bump + publish flow
pnpm release:dry            # dry-run release flow
```

## Testing

Tests are colocated as `*.test.ts` next to the implementation under `src/`, plus cross-cutting suites under `tests/agent/` and `tests/telegram/`.

```bash
pnpm test                                   # all
pnpm test -- src/agent/session.test.ts      # single file
pnpm test -- -t "sends a message"           # single test by name
pnpm test:watch                             # watch
pnpm test:coverage                          # with coverage
```

**What to test:**
- New provider events and stream transitions
- Hook lifecycle (SessionStart/End, SubagentStart/Stop, PreToolUse/PostToolUse)
- Subagent fork + abort cascades
- Skill registration and dispatch through the slash registry
- Any change to `~/.afk/` paths or config resolution

Vendored agents under `src/skills/_agents/` must stay byte-equal to upstream — drift is enforced by `vendored.test.ts`.

## Conventions

- **`tsconfig.json` is maximally strict**: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`. All code must pass `tsc --noEmit`.
- The agent-afk system prompt is a raw string from config or file. No SDK preset is loaded.
- `AgentSession` constructor is **synchronous**; SDK lifecycle runs async via `initSdkLifecycle()` and surfaces through the provider event stream.
- DAG executor (`src/agent/dag.ts`) is a Phase 2 stub — types exported but `runDAG` throws.
- **SDK dependency tracking**: every import from `@anthropic-ai/sdk` is in `.sdk-dependency.lock.json`. CI fails on unlocked new symbols. After adding an SDK import, run `pnpm audit:sdk:update-lock` and edit the new entry's `reason` field before commit.
- Build copies `*.md` prompt files from `src/` into `dist/` via `scripts/copy-prompts.js`.
- Vendored agents under `src/skills/_agents/` must stay byte-equal to upstream.

### Ordered-operation sequences

Before generating sequences of terminal writes, async state mutations, or persistence-then-UI ops:

- Name the external constraint governing the sequence (protocol / event-loop boundary / semantic invariant).
- Emit the constraint as a code comment, not just in reasoning.
- TUI code: write teardown **before** setup in the source file so the inverse is never orphaned.
- No optimistic rendering — never emit a UI update before its dependent write has a confirmed result, unless explicitly specified.

### Commit messages

Conventional Commits format:

```
<type>(<scope>): <subject>

<body>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`.

Examples:

```
feat(provider): add Codex streaming support
fix(telegram): resolve bot entrypoint in bundled dist layout
docs(readme): rewrite for npm audience
refactor(session): extract stream consumer
```

## Project structure

```
agent-afk/
├── src/
│   ├── cli/
│   │   ├── index.ts                # CLI entry (commander)
│   │   ├── commands/               # chat, interactive, status, config, daemon,
│   │   │                           # login, plugin, marketplace, doctor,
│   │   │                           # completion, telegram, etc.
│   │   ├── slash/                  # REPL slash registry + commands/
│   │   ├── input/                  # raw-mode, bracketed paste, clipboard images
│   │   ├── background-status-bar.ts
│   │   ├── context-sampler.ts
│   │   ├── update-checker.ts
│   │   └── config.ts, shared-helpers.ts
│   ├── agent/
│   │   ├── session.ts              # AgentSession barrel
│   │   ├── session/                # agent-session, query-options, …
│   │   ├── subagent.ts             # SubagentManager barrel
│   │   ├── subagent/               # forkSubagent implementation
│   │   ├── subagent-hooks.ts
│   │   ├── routing-telemetry.ts    # appends routing-decisions.jsonl
│   │   ├── daemon/                 # long-running headless agent
│   │   ├── plugins/                # afk plugin install / update / remove
│   │   ├── marketplaces/           # marketplace install / resolve / manifest
│   │   ├── providers/              # anthropic-direct, openai-codex
│   │   ├── memory/                 # cross-session memory + HOT.md loader
│   │   ├── tools/                  # built-in tool dispatcher + handlers
│   │   ├── elicitation-router.ts
│   │   ├── hook-registry.ts, hooks.ts, default-hook-registry.ts
│   │   ├── permissions.ts, abort-graph.ts, dag.ts, message-queue.ts
│   │   ├── output-extractor.ts, plugins-scanner.ts, timeout.ts
│   │   └── types.ts, types/
│   ├── skills/
│   │   ├── all.ts                  # canonical skill registry
│   │   ├── mint/                   # /mint
│   │   ├── diagnose/               # /diagnose
│   │   ├── audit-fit/              # /audit-fit (internal tier)
│   │   ├── _agents/                # vendored subagents
│   │   ├── _lib/                   # prompt-loader, shared helpers
│   │   └── user-skills.ts          # lazy scan of ~/.afk/skills
│   ├── telemetry/                  # shared telemetry schemas
│   ├── telegram/                   # telegram bridge
│   ├── telegram.ts                 # telegram bot entry
│   ├── utils/
│   ├── paths.ts
│   └── index.ts
├── tests/
│   ├── agent/                      # cross-cutting integration suites
│   └── telegram/                   # telegram bridge tests
├── scripts/
│   ├── copy-prompts.js             # bundles src/**/*.md into dist/ after tsc
│   ├── build-dist.mjs              # esbuild release bundle
│   ├── release.mjs                 # version bump + publish flow
│   ├── generate-changelog.mjs
│   ├── audit-sdk-dependency.ts
│   ├── colocate-tests.mjs
│   ├── telegram-manager.sh
│   └── verify-install.sh
├── docs/                           # internal docs (this directory)
├── AGENTS.md                       # operator/agent runtime brief
├── CHANGELOG.md
├── CLAUDE.md                       # Claude Code instructions
├── AFK.md                          # session system prompt
├── afk.config.json.example
├── pnpm-lock.yaml
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Releasing

Release flow is automated by `scripts/release.mjs`:

```bash
pnpm release:dry           # rehearse — no git push, no npm publish
pnpm release               # version bump + CHANGELOG entry + git tag + publish
```

Under the hood:

1. **`prepublishOnly`** runs `clean && build:dist`. This deletes `dist/` and rebuilds via esbuild (not `tsc`).
2. **`scripts/build-dist.mjs`** bundles three entry points to flat ESM:
   - `src/cli/index.ts` → `dist/cli.mjs`
   - `src/telegram.ts` → `dist/telegram.mjs`
   - `src/index.ts` → `dist/index.mjs`
3. Post-process: shebang injection + chmod +x on `cli.mjs` and `telegram.mjs`.
4. `scripts/postinstall.mjs` is copied into `dist/` so it ships in the tarball.
5. `package.json#bin.afk` → `dist/cli.mjs` matches the esbuild output.
6. `files: ["dist/"]` means only `dist/` ships. Source, tests, scripts, and prompts are excluded by `.npmignore`.

**Two parallel build pipelines, by design:**

| Pipeline | Output | Used by |
|---|---|---|
| `pnpm build` (tsc) | `dist/cli/index.js` (tree form) | `pnpm start`, local development |
| `pnpm build:dist` (esbuild) | `dist/cli.mjs` (flat bundle) | npm tarball, `package.json#bin` |

## Build process

```bash
pnpm clean && pnpm build    # full clean rebuild
pnpm dev                    # auto-rebuild (tsx watch)
pnpm lint                   # type-check without emitting
```

For more on the architecture (providers, hooks, subagents, abort graph), see [`architecture.md`](architecture.md). For the full env-var reference and slash-command taxonomy, see [`reference.md`](reference.md).
