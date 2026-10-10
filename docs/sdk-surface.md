# SDK Tool Surface

By default, sessions created through the public `agent-afk` package
(`AgentSession`, `query()`, `queryText()`) run with a **reduced tool surface**
compared with the CLI, REPL, Telegram bot, daemon, and `afk web` surfaces.
Opt in to `agent`, `skill`, and `compose` by passing `AgentConfig.executors`
built with `createWiredExecutors()` (see "Opting in" below and the SDK docs page).

## What is absent in default SDK sessions

| Tool | Reason absent |
|---|---|
| `agent` | Requires `subagentExecutor` — built only by `wireExecutors()` in CLI/web wiring |
| `skill` | Requires `skillExecutor` — same |
| `compose` | Requires `composeExecutor` — same |
| `cancel_background_job` | Gated on `subagentExecutor.supportsBackgroundJobs()` |
| `send_message_to_agent` | Same gate |
| `get_background_job_health` | Same gate |

All other built-in tools (`bash`, `read_file`, `edit_file`, memory tools,
state tools, MCP tools, etc.) are present as normal.

## Why skills are discovered but not invokable

`supportedCommands()` returns skills discovered by the skill-bridge (built-in
TS skills, `~/.afk/skills/`, and plugin SKILL.md files). This list is correct
and complete. However, **the model has no `skill` tool to call**, so a system
prompt that says "use the `/mint` skill" gets an improvised answer from the
model's base knowledge and MCP tools instead of running the actual skill flow.

The executors that back the `agent`, `skill`, and `compose` tools carry
depth/concurrency limits, watchdogs, plugin discovery, and budget accounting
that have trade-offs for embedder processes (e.g. a Next.js route with
`maxDuration = 300`), so they stay opt-in rather than default.

## Opting in

```ts
import { AgentSession, createWiredExecutors } from 'agent-afk';

const { executors } = createWiredExecutors(
  { model: 'sonnet' },
  { agent: true, skill: ['my-plugin:review'], compose: true, unattended: true },
);
const session = new AgentSession({ model: 'sonnet', executors });
```

`createWiredExecutors` fails closed unless you pass a hook registry or
`unattended: true`, defaults `pluginConfigs` to `[]` (no `~/.afk` or imported
plugin discovery), enforces the skill allowlist at every nesting depth, and
counts subagent spend toward `maxBudgetUsd`. Background jobs stay unavailable.
One bundle binds to exactly one session.

## Runtime signal

After `waitForInitialization()` resolves, `SessionMetadata.reducedToolSurface`
is `true` when this gap is present:

```ts
const session = new AgentSession({ model: 'sonnet', apiKey: '...' });
const meta = await session.waitForInitialization();

if (meta.reducedToolSurface) {
  console.warn('Agent cannot invoke skills or spawn subagents in this session.');
}
```

The first time a session in the process runs a model turn with this gap, a
one-time warning is also written to stderr (construction alone stays silent):

```
[agent-afk] SDK session: 37 skills discovered but the "skill", "agent", and
"compose" tools are NOT registered. Skills are listed by supportedCommands()
but the model cannot invoke them. This is expected when using AgentSession /
query() / queryText() directly without executor wiring. Opt in with
AgentConfig.executors from createWiredExecutors(); see docs/sdk-surface.md.
Set AFK_SDK_SURFACE_WARN=0 to silence this warning.
```

Set `AFK_SDK_SURFACE_WARN=0` in your environment to suppress the warning
(useful when the reduced surface is intentional and you do not want the noise).

## Surfaces that are NOT affected

The following surfaces wire executors at startup and are **not** affected:

- `afk interactive` (REPL) — `wireExecutors()` + `createReplProviders()`
- `afk telegram start` — same
- `afk web` — `src/web-server/session-owner.wiring.ts`
- `afk daemon` — full executor wiring

`SessionMetadata.reducedToolSurface` is absent (or `false`) on all of these.

## Background jobs

Background subagent jobs are not available through `createWiredExecutors`.
An embedder that needs them can proxy to `afk web` (`afk web --port 3001`),
which runs the full executor stack including background jobs.

## Related

- Issue [#3442](https://github.com/griffinwork40/agent-afk/issues/3442).
- `src/agent/session/create-wired-executors.ts` — the opt-in factory.
- `src/agent/session/sdk-surface-warning.ts` — detection and warning logic.
- `src/agent/types/session-types.ts` — `SessionMetadata.reducedToolSurface`.
- `src/agent/providers/anthropic-direct/provider-schemas.ts` — where
  `agent`/`skill`/`compose` are gated on executors.
- `src/web-server/session-owner.wiring.ts` — reference implementation of
  executor wiring for an HTTP surface.
