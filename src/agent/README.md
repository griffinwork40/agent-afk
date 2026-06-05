# AgentSession harness

`src/agent/` is the provider-agnostic session harness that drives every agent-afk
turn. `AgentSession` is the single runtime entry point: it owns conversation
history, dispatches lifecycle hooks, and delegates inference + tool calls to a
`ModelProvider`.

What this module is **not**:

- Not a wrapper around the Claude Code subprocess. There is no subprocess; the
  Anthropic provider talks to the Messages API directly.
- Not the Anthropic Agent SDK. agent-afk used to depend on
  `@anthropic-ai/claude-agent-sdk`; the active default provider now wraps
  `@anthropic-ai/sdk` instead. Some SDK types still live under `types/sdk-types.ts`
  as local copies.

For repo-wide context (CLI, Telegram surface, `~/.afk/` layout, SDK dependency
tracking, system-prompt discovery) see `CLAUDE.md` at the repo root. This README
is scoped to `src/agent/`.

## Layout

| Path | Purpose |
|------|---------|
| `session/` | `AgentSession` + lifecycle: init, stream consumption, turn loop, reset. |
| `providers/` | Model adapters. `providerForModel()` picks one by model family. |
| `providers/anthropic-direct/` | Direct Messages API integration (default for Claude). |
| `providers/openai-compatible/` | Direct Chat Completions API integration (default for GPT/o-series/codex models). Also supports any OpenAI-compatible endpoint via `baseURL`. |
| `tools/` | Built-in tool schemas (Bash, Read, Edit, EditBatch, WebFetch, WebSearch, Skill, Compose) and the dispatcher. |
| `subagent/` | `SubagentHandle` implementation, result and trace types. |
| `types/` | Config, message, model, permission, session types. `sdk-types.ts` holds local copies of types previously imported from the agent SDK. |
| `daemon/` | Cron scheduler, scheduled-task types, gates, telemetry. |
| `memory/` | `MemoryStore`, memory-backed tools, and memory hooks. |
| `marketplaces/` | Plugin marketplace resolve / install / remove / update. |
| `plugins/` | Local plugin discovery and install. |

## Providers

```
ModelProvider
├── anthropic-direct    (default for claude-*, opus, sonnet, haiku)
└── openai-compatible   (default for gpt-*, o1*, o3*, o4*, codex-*)
```

`providers/index.ts` exports `providerForModel(model)` which routes by model
family. The provider name `'anthropic'` is a silent alias for
`'anthropic-direct'`. Both providers emit a normalized `ProviderEvent` stream
consumed by `session/stream-consumer.ts`. Nothing outside `providers/` imports a
model SDK directly.

### anthropic-direct

The default provider, implemented in `providers/anthropic-direct/`:

| File | Responsibility |
|------|----------------|
| `query.ts` | Instantiates the `Anthropic` client and orchestrates a query. |
| `loop.ts` | Multi-turn loop: model call, tool dispatch, append, repeat. |
| `auth.ts` | Detects OAuth vs `x-api-key` authentication. |
| `cache-policy.ts` | Manages prompt-cache breakpoints across turns. |
| `compact.ts` | Summarizes history when the context budget is exceeded. |
| `tool-dispatcher.ts` | Routes tool calls to handlers in `../../tools/`. |
| `translate.ts` | Translates between provider-neutral and Messages API shapes. |

### openai-compatible

`providers/openai-compatible/` talks directly to the OpenAI Chat Completions
API via the official `openai` npm package, and emits the same `ProviderEvent`
shape as `anthropic-direct`. Tool dispatch, hooks, permissions, and
sub-agent/skill/compose execution all run through AFK's own
`SessionToolDispatcher` — the provider only translates between AFK's
normalized messages/tools and OpenAI's wire shape.

| File | Responsibility |
|------|----------------|
| `index.ts` | Provider class. Mirrors `AnthropicDirectProvider`'s constructor surface. |
| `query.ts` | Per-query state, stream pump, tool-call iteration loop. |
| `auth.ts` | Resolves auth from `AgentConfig.apiKey`, `OPENAI_API_KEY`, `CODEX_API_KEY`, and `~/.codex/auth.json` (API key only — ChatGPT OAuth is rejected with a clear diagnostic). |
| `messages.ts` | Translates between AFK's `MessageParam[]` history and OpenAI's `messages: [...]` request shape. |
| `translate.ts` | Streams OpenAI `chat.completions.chunk` events → `ProviderEvent` deltas. |
| `loop.ts` | Pure helpers: tool-schema conversion (`AnthropicToolDef` → OpenAI `tools[]`), tool-call accumulation. |

Compatible with any OpenAI-compatible endpoint via `baseURL` (e.g.
NVIDIA NIM, vLLM, llama.cpp's `/v1/chat/completions` shim). Does not
currently support `compact()`.

The historical `openai-codex` provider (wrapper around `@openai/codex-sdk`)
was retired in slice 5 of the 2026-05-18 provider refactor; the name is
still accepted as a deprecated alias by `parseProvider`.

## AgentSession

Constructor:

```ts
new AgentSession(config: AgentConfig)
```

The constructor is synchronous. The provider's lifecycle (client construction,
initial metadata) runs asynchronously via `initSdkLifecycle()` and surfaces
through the provider event stream. Use `waitForInitialization()` if you need to
block until session metadata is available.

### State machine

```
state: 'idle' | 'processing' | 'streaming' | 'closed'
```

Other readable surface: `sessionId`, `abortSignal`.

### Public methods

**Turn entry points**

- `sendMessage(content, options?): Promise<Message>` — blocking; resolves with the full assistant response.
- `sendMessageStream(content): AsyncIterableIterator<OutputEvent>` — same loop, streamed as `OutputEvent`s.
- `interrupt(): Promise<void>` — abort the in-flight turn.

**Lifecycle**

- `waitForInitialization(): Promise<SessionMetadata>`
- `reset(): Promise<void>` — tears down and rebuilds from the original config. Preserves the registered abort signal and hooks.
- `setModel(model?)`, `setPermissionMode(mode)`
- `close(): Promise<void>`

**Inspection**

- `getHistory(): readonly Message[]`
- `getTurnCount(): number`
- `getSessionIdentity()`, `getSessionMetadata()`
- `getContextUsage()`, `mcpServerStatus()`, `accountInfo()`
- `supportedCommands()`, `supportedModels()`, `supportedAgents()`
- `rewindFiles(userMessageId, options?)`

**Provider escape hatches**

- `getQuery(): ProviderQuery` — the lower-level provider handle. Callers should
  prefer the higher-level methods above.
- `compact(): Promise<ProviderCompactResult>` — anthropic-direct only.

### Minimal usage

```ts
import { AgentSession } from './session.js';

const session = new AgentSession({
  model: 'sonnet',
  systemPrompt: 'You are a helpful assistant.',
});

const reply = await session.sendMessage('Summarize the project README.');
console.log(reply.content);

await session.close();
```

Streaming:

```ts
for await (const event of session.sendMessageStream('Refactor src/x.ts')) {
  if (event.type === 'chunk' && event.chunk.type === 'content') {
    process.stdout.write(event.chunk.content);
  }
}
```

## Cross-cutting subsystems

| Subsystem | File(s) | Notes |
|-----------|---------|-------|
| Hooks | `hooks.ts`, `hook-registry.ts` | SessionStart/End, SubagentStart/Stop, PreToolUse/PostToolUse. Handlers run sequentially; `decision: 'block'` short-circuits. SubagentStop supports `injectContext` for parent-session context injection. |
| SubagentManager | `subagent.ts` | Forks child `AgentSession` instances with permission bubbling, transitive abort, and optional Zod output schemas. |
| AbortGraph | `abort-graph.ts` | Tree of `AbortController`s. Parent abort cascades to descendants; child abort notifies the parent but never auto-aborts it. Abort always wins over hook decisions. |
| Elicitation router | `elicitation-router.ts` | Module-scope handler for SDK elicitation requests. Auto-declines on timeout. |
| Plugins scanner | `plugins-scanner.ts` | Scans `~/.afk/plugins/` for `.claude-plugin/plugin.json` up to depth 5. |
| DAG | `dag.ts` | Kahn layer-by-layer workflow executor. Types are exported; `runDAG()` throws — not yet implemented. |
| Daemon | `daemon.ts`, `daemon/` | Cron-scheduled task runner with an HTTP control surface on port 7777. |

## Subagent return contract

When dispatching a subagent (raw `agent` tool or skill-internal `forkSubagent`),
the dispatching prompt should specify the return shape. Default shape:

- Answer: one paragraph
- Evidence: file:line citations
- Confidence: low | medium | high
- Risks / unknowns: bulleted
- Recommended next action: one line
- Not checked: bulleted

Target length ≤500 lines. The dispatching session should never receive >2000
lines from one subagent. If raw evidence is required, save it to a file and
reference the path — don't inline it into the return.
