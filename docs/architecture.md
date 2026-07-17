# Architecture

How `agent-afk` is put together. Reference for contributors and anyone embedding `AgentSession` programmatically. For build/test/release mechanics, see [`development.md`](development.md). For env vars and slash taxonomy, see [`reference.md`](reference.md).

## Three layers under `src/`

| Path | Purpose |
|------|---------|
| `src/agent/` | Provider-agnostic session harness. `AgentSession` is the single runtime entry point; delegates to a `ModelProvider` from `providerForModel()`. |
| `src/agent/providers/anthropic-direct/` | Wraps `@anthropic-ai/sdk` Messages API. Default for `claude-*`, `opus`, `sonnet`, `haiku`. `'anthropic'` is a silent alias. |
| `src/agent/providers/openai-compatible/` | Talks directly to OpenAI's Chat Completions API (and any compatible endpoint via `baseURL`). Default for `gpt-*`, `o1*`, `o3*`, `o4*`, `codex-*`, and HuggingFace-style `org/model` ids served by local OpenAI-shim runners. `'openai-codex'` is a deprecated alias. |
| `src/cli/` | Commander-based terminal surface. Commands in `src/cli/commands/`. REPL: `commands/interactive/` (bootstrap → loop → turn → markdown stream → cleanup). Slash commands in `src/cli/slash/` via Levenshtein-hint dispatcher. |
| `src/telegram/` | Telegraf bot, per-chat session management, allowlist via `AFK_TELEGRAM_ALLOWED_CHAT_IDS`. |
| `src/skills/` | Headless mirrors of plugin orchestration skills. Each has `prompts/` (markdown) loaded by `src/skills/_lib/prompt-loader.ts`. |
| `src/skills/_agents/` | Vendored agent definitions. Drift detection: `vendored.test.ts`. |

Both providers emit a normalized `ProviderEvent` stream consumed by `src/agent/session/stream-consumer.ts`. **No model SDK is imported for runtime use outside `src/agent/providers/`** — the rest of the tree imports only the SDK's `ContentBlockParam` *type*, with one legacy runtime `Anthropic` import in `src/cli/interactive.ts` as a known exception.

## Cross-cutting subsystems

- **Hooks** (`src/agent/hooks.ts`, `hook-registry.ts`) — SessionStart/End, SubagentStart/Stop, PreToolUse/PostToolUse. Sequential; `decision: 'block'` short-circuits. Foreground subagent final output returns through the normal `agent` tool result. Separately, `SubagentStop` supports `injectContext`: a hook-generated framework note (not human-authored user text) queued into the parent input stream for the next parent turn. Injection is skipped when the parent is aborting, is not guaranteed on DAG/compose or background paths, and multiple injected contexts currently do not merge (last non-blocking hook decision wins).
- **SubagentManager** (`src/agent/subagent.ts`) — Forks child `AgentSession`s with permission bubbling, transitive abort via `AbortGraph`, optional Zod output schemas.
- **AbortGraph** (`src/agent/abort-graph.ts`) — Tree of `AbortController`s. Parent abort cascades down; child abort notifies up (never auto-aborts parent). Abort beats hook decisions.
- **Elicitation Router** (`src/agent/elicitation-router.ts`) — Module-scope handler bridging SDK elicitations to REPL/Telegram/iMessage surfaces.
- **Plugins** (`src/agent/plugins-scanner.ts`, `src/agent/plugins/`) — Scans `~/.afk/plugins/` at session construction; install/remove/update + git-based sources.

## Skills & subagents

`agent-afk` ships six built-in skills exposed through the slash registry: typing `/mint add dark mode` in the REPL parses the slash form, resolves it to a TypeScript handler under `src/skills/<name>/index.ts`, and dispatches a fresh subagent via `SubagentManager.forkSubagent()`. Every dispatch is logged to `~/.afk/agent-framework/routing-decisions.jsonl`.

The canonical list lives in `src/skills/all.ts`:

| Skill | Purpose |
|---|---|
| `/mint` | End-to-end feature/refactor pipeline: spec → research → plan → parallelize → build → verify → heal → ship |
| `/diagnose` | Parallel hypothesis generation + validation for bugs and failing tests |
| `/audit-fit` | Audit `~/.afk` artifacts (skills, commands, agents, hooks) for correct type categorization |
| `/get-started` | Guided first-run onboarding for AFK |
| `/service-setup` | Install an AFK background process (telegram bot / daemon) as a macOS LaunchAgent |
| `/telegram-setup` | First-time Telegram bot onboarding |

Skills surface in two shapes:

- **Built-in (this repo)** — TypeScript handlers under `src/skills/<name>/`, registered via `src/skills/all.ts` and bridged into the slash registry by `src/cli/slash/builtin-skills.ts`.
- **Plugin / user** — `SKILL.md` files discovered under `~/.afk/plugins/<plugin>/skills/<skill>/` or `~/.afk/skills/<skill>/`, scanned at session start and auto-exposed as slash commands.

Vendored subagents (`research-agent`, `contract`) live under `src/skills/_agents/` and are kept byte-equal with the upstream copies — drift is caught by tests in `src/skills/_agents/`.

## User-scope state

All AFK state under `~/.afk/` (never `~/.claude/`):

```
~/.afk/
  config/    afk.env, afk.config.json, mcp.json, settings.json (shell-hook trust gate, etc.)
  state/     sessions/  todos/  transcripts/  daemon/   ($AFK_STATE_DIR overrides this tier)
  plugins/   logs/  cache/
  agents/    user-defined subagents
  commands/  user-defined slash commands
  skills/    user-defined skills
  agent-framework/   AFK telemetry + briefs (via paths.ts)
```

The plugin surface writes to `~/.claude/agent-framework/` independently — no shared state.

## System prompt discovery

The base system prompt is **layered**. The framework prompt (`prompts/system-prompt.md`, inlined into the bundle at publish-build) is the unconditional foundation; the resolved operator overlay is **appended** on top of it beneath an `# Operator configuration` header — it never replaces the framework base. `resolveBaseSystemPrompt()` (`src/cli/shared-helpers.ts`) performs the layering for every top-level surface (one-shot `chat`, REPL, Telegram, farm), and `composeSystemPrompt()` is the pure compose primitive.

`loadConfig()` resolves the **operator overlay** across three tiers (highest wins); `loadConfig().systemPrompt` is that overlay alone (unchanged — it does not include the framework base):

| Tier | Overlay source | `loadConfig().systemPromptSource` |
|------|--------|----------------------|
| 1 | `AFK_SYSTEM_PROMPT` env | `env:AFK_SYSTEM_PROMPT` |
| 2 | `afk.config.json` (cwd → `~/.afk/config/` → legacy) | `file:<abs>` |
| 3 | `AFK.md` (cwd → `$AFK_HOME/`) | `afk-md:<abs>` |
| — | None | `undefined` |

`AFK.md` is plain markdown, no frontmatter. Empty/whitespace → treated as absent. The framework base is always present regardless of overlay tier, so an absent overlay just means the model gets the framework prompt alone. The composed prompt is sent to the Messages API as a raw string (never as an SDK preset).

> **Escape hatch (not yet implemented):** every overlay appends — there is currently no way to fully replace the framework base. A future opt-out (e.g. `AFK_BASE_PROMPT=0`) would restore clean-slate behavior; until then the framework base is unconditional.

**Bootstrapping `AFK.md`:** run `/init` in the REPL to scan the current project and generate a tailored `AFK.md` at the repo root. Implementation: `src/cli/slash/commands/init.ts`.

**Provenance tracking:** `--dump-prompt` reports a layered `systemPromptSource`, and the full composed text lands in the dump's `options.system` field:
- `"framework"` — base only, no overlay configured
- `"framework+env:AFK_SYSTEM_PROMPT"` — base + tier-1 overlay
- `"framework+file:/abs/path/afk.config.json"` — base + tier-2 overlay
- `"framework+afk-md:/abs/path/AFK.md"` — base + tier-3 overlay

(`loadConfig().systemPromptSource` keeps its un-prefixed overlay-only value; the `framework+…` composition is applied by `resolveBaseSystemPrompt()` at the surface.)

## Prompt caching (anthropic-direct provider)

The `anthropic-direct` provider stamps two `cache_control` breakpoints per request — one at the end of `system` (which implicitly caches `tools + system` together) and one at the end of the last `messages[]` entry. The end-of-messages marker floats forward each turn; cache lookup walks back over prefix-hash matches up to a 20-block window, so the moving marker still hits prior cache writes within a tool-use loop and across consecutive turns.

Defaults are tuned for `agent-afk`'s long-lived surfaces (daemon, Telegram bot) which often idle past the 5-minute window:

| Variable | Values | Default | Effect |
|---|---|---|---|
| `AFK_DISABLE_PROMPT_CACHE` | `1` / `true` / `yes` / `on` (case-insensitive) | unset (cache enabled) | Disables both breakpoints; useful for A/B comparisons and debugging cache-attribution issues |
| `AFK_PROMPT_CACHE_TTL` | `5m` / `1h` | `1h` | TTL for both breakpoints. Anything other than `5m` or `1h` falls back to the default |

Markers never leak back into stored history — `cache-policy.ts` clones-and-stamps so the canonical `messages` array stays marker-free across iterations (accumulating markers would break prefix-hash matching). Implementation: [`src/agent/providers/anthropic-direct/cache-policy.ts`](../src/agent/providers/anthropic-direct/cache-policy.ts).

## Runtime features

- **Cross-session memory** — three built-in tools (`memory_search`, `memory_update`, `procedure_write`) backed by SQLite at `~/.afk/agent-framework/memory/`. `HOT.md` is injected into every future session's system prompt for durable essentials. See `src/agent/memory/` and `src/agent/tools/handlers/memory-*.ts`.
- **`compose` tool — DAG-based orchestration** — agents (and the main session) can dispatch up to 20 subagent nodes with explicit dependency edges. Independent nodes run in parallel; dependent nodes wait. Fail-fast cancels downstream nodes by default. See `src/agent/tools/compose-executor.ts` and `src/agent/dag.ts`.
- **Background subagent jobs** — dispatching an `agent` tool call with `mode:'background'` detaches the subagent into the `BackgroundAgentRegistry`. When a job settles, its result is auto-delivered into the model's context with the next user message (`BgResultNotifier`; opt out with `AFK_BG_AUTO_DELIVER=0`). `/bgsub` lists running and completed jobs; `/bgsub:join <id>` replays a result manually. Status bar at the bottom of the REPL surfaces running job counts. Implementation: `src/cli/background-status-bar.ts`, `src/cli/commands/interactive/bg-result-notifier.ts`, `src/agent/background-registry.ts`.
- **`send_telegram` built-in tool** — agents can push terminal-state notifications to the operator. Recipients are gated by `AFK_TELEGRAM_ALLOWED_CHAT_IDS`; safe to attempt unconditionally (returns an error if Telegram is unconfigured). Handler: `src/agent/tools/handlers/send-telegram.ts`.
- **Extended thinking on by default** — Anthropic's thinking budget is auto-enabled. Override per-session with `--thinking on|off|<budget-tokens>` or globally with `AFK_THINKING`.
- **`/tokens`** — authoritative breakdown of context usage: total vs model max, auto-compact threshold, top categories, system tools, MCP tools, agents, skills, slash commands, and the last-turn API usage.
- **Status-line context %** — sampled every few turns from `session.getContextUsage()`, cached between samples, degrades gracefully on transient failures. See `src/cli/context-sampler.ts`.
- **Progress banners** — when the provider emits `task_progress` events (long subagent runs, multi-tool flows), they render inline as `◦ description (stats)` with an indented summary when present. Telegram forwards the same lines with edit-throttling, and prompt suggestions trail as `💡` lines below the response.
- **Cost guardrails** — `--max-budget-usd <n>` / `AFK_MAX_BUDGET_USD` aborts on cost breach. `--task-budget <tokens>` / `AFK_TASK_BUDGET` is an advisory per-task hint surfaced to the model.
- **MCP elicitations** — when an MCP server requests OAuth consent (e.g. Supabase re-auth), the REPL prints the server name, message, and URL, then asks `Continue? [y/N]`. Empty cancels; `n` declines; `y` accepts. Form-mode elicitations are auto-declined in v1. Handler: `src/agent/elicitation-router.ts`.
- **Clipboard image paste** — paste images directly into the REPL (macOS pasteboard; bracketed-paste-aware). See `src/cli/input/clipboard-image.ts`.
- **Auto-update check** — startup checks for a newer published version and prints a notice. Suppress with `afk --no-update-check`. Policy field `updatePolicy` (`notify`|`auto`|`off`) lives in `afk.config.json`. Implementation: `src/cli/update-checker.ts`.

## Bypass permissions

Permission mode `'default'` runs tools without a per-tool approval prompt, but a file tool touching a path **outside the session's granted roots** triggers a path-approval prompt (and out-of-root access stays contained until granted). There is no per-tool "allow this bash command?" flow.

**Bypass mode** (`permissionMode: 'bypassPermissions'`) disables path containment and the path-approval prompt entirely — filesystem tools may read/write any path with no confirmation:

- Skips path-approval prompts; disables out-of-root containment
- Allows fully automated workflows
- Enable with `/bypass` in the REPL (status line shows `⚡ bypass`)
- Does **not** affect `ask_question` (the model asking you a question is a separate axis)

### Default mode by surface

The effective default is resolved per surface, not in one global constant:

| Surface | Default mode | Where it's set |
|---------|--------------|----------------|
| `afk chat`, `afk interactive` (REPL) | **`bypassPermissions`** | `DEFAULT_CLI_PERMISSION_MODE` in `src/cli/config.ts` — the `loadConfig()` resolution layer that both surfaces read. An `afk.config.json` `permissionMode` key overrides it. |
| Telegram | `default` | `src/telegram.ts` omits `permissionMode`; relies on hook-based enforcement + the operator's `allowedTools`. |
| `afk daemon` | `bypassPermissions` | `src/agent/daemon/scheduler.ts` sets it explicitly (no human to prompt). |
| Embedded `new AgentSession(...)` / subagents inheriting no mode | `default` | The session-layer `?? 'default'` fallback in `src/agent/session/session-setup.ts`. |

So the **CLI surfaces are bypass-by-default for new installs** (built for unattended work, where a permission prompt with no human in front of it just wedges the session — use on a machine and account you trust), while Telegram, the embedding API, and uninitialised subagents stay contained. Change the CLI default with `afk config set permissionMode default` (persistent) or `/bypass` (live, one session).

### Default allowed tools

Sub-agents inherit a default allowlist defined in `src/agent/tools/nesting.ts` as `CHILD_ALLOWED_TOOLS`:

```typescript
// src/agent/tools/nesting.ts
export const CHILD_ALLOWED_TOOLS = [
  ...BUILTIN_TOOL_NAMES,    // bash, read_file, write_file, edit_file, glob, grep, web_scrape, …
  ...AWARENESS_TOOL_NAMES,  // get_runtime_state, …
  'memory_search', 'agent', 'skill',
];
```

A read-only skill's forked child uses the tighter `RECON_ALLOWED_TOOLS` instead (no `write_file`/`edit_file`; `bash` admitted only behind the mutating-command guard). Override per-session by passing `config.tools.allowedTools` to `AgentSession`, or disable individual tools via `config.tools.disallowedTools`.

## `AgentSession` API

For embedding `agent-afk` programmatically:

```typescript
import { AgentSession } from 'agent-afk';

const session = new AgentSession({
  model: 'sonnet',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  maxTurns: 100,
  systemPrompt: 'You are a helpful assistant.',
  tools: {
    allowedTools: ['Bash', 'Read', 'Write'],
  },
});

// Single message
const response = await session.sendMessage('Hello!');
console.log(response.content);

// Streaming (async iterator) — text arrives as `content` chunks
for await (const event of session.sendMessageStream('Tell me a story')) {
  if (event.type === 'chunk' && event.chunk.type === 'content') {
    process.stdout.write(event.chunk.content);
  }
}

// Runtime control
await session.interrupt();                       // cancel in-flight turn
await session.setModel('opus');                  // hot-swap model
await session.setPermissionMode('acceptEdits');  // switch permission mode

// State accessors
session.state;                    // 'idle' | 'processing' | 'streaming' | 'closed'
session.sessionId;                // string | undefined
session.abortSignal;              // AbortSignal
const history = session.getHistory();

// Cleanup
await session.close();
```

### Types

```typescript
interface AgentConfig {
  model: 'opus' | 'sonnet' | 'haiku';
  apiKey: string;
  maxTurns?: number;
  systemPrompt?: string;
  tools?: {
    allowedTools?: string[];
    disallowedTools?: string[];
  };
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

type SessionState = 'idle' | 'processing' | 'streaming' | 'closed';
```

This API surface is a public import from the npm package: `package.json` declares `main`, `types`, and an `exports` map, so `import { AgentSession, query, tool } from 'agent-afk'` resolves against the published `dist/` without building from source. For a task-oriented walkthrough (one-shot `query*`, custom tools, subagents, providers, permission hooks) see the [Build with the SDK](https://docs.agentafk.com/sdk) guide.
