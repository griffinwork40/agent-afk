# SDK Tool Surface

When you create sessions through the public `agent-afk` package
(`AgentSession`, `query()`, `queryText()`), the session runs with a **reduced
tool surface** compared with the CLI, REPL, Telegram bot, daemon, and
`afk web` surfaces.

## What is absent in SDK sessions

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

This is a structural gap, not a bug. The executors that back the `agent`,
`skill`, and `compose` tools require depth/concurrency limits, wall-clock
watchdogs, and budget-rollup accounting that have design trade-offs for
long-lived embedder processes (e.g. a Next.js route with `maxDuration = 300`).
Options 1 and 2 from issue [#3442](https://github.com/griffinwork40/agent-afk/issues/3442)
(opt-in full runtime and exported executor factory) remain open for a future
release.

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

A one-time warning is also written to stderr automatically:

```
[agent-afk] SDK session: 37 skills discovered but the "skill", "agent", and
"compose" tools are NOT registered. Skills are listed by supportedCommands()
but the model cannot invoke them. This is expected when using AgentSession /
query() / queryText() directly without executor wiring. See docs/sdk-surface.md
for details. Set AFK_SDK_SURFACE_WARN=0 to silence this warning.
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

## Workaround

For a Next.js or other embedder that needs skill/subagent support today,
proxy to `afk web` (`afk web --port 3001`) and point your HTTP client at it.
`afk web` runs the full executor stack including background jobs.

## Related

- Issue [#3442](https://github.com/griffinwork40/agent-afk/issues/3442) — full
  discussion of options 1 (opt-in runtime) and 2 (exported executor factory).
- `src/agent/session/sdk-surface-warning.ts` — detection and warning logic.
- `src/agent/types/session-types.ts` — `SessionMetadata.reducedToolSurface`.
- `src/agent/providers/anthropic-direct/provider-schemas.ts` — where
  `agent`/`skill`/`compose` are gated on executors.
- `src/web-server/session-owner.wiring.ts` — reference implementation of
  executor wiring for an HTTP surface.
