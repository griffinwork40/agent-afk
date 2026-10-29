# get_runtime_state

Agent tool that returns a compact JSON snapshot of session identity, tool affordances, subagent state, and workspace context. The agent calls it when uncertain about its environment; humans see the same data via `/debug`, `/tools`, `/info`, and `/where` slash commands.

## Views

Request a specific view to keep the response compact. Default is `all`.

### `self`

Session identity, model, and permissions:

| Field | Type | Notes |
|-------|------|-------|
| `sessionId` | `string \| null` | Stable UUID; null only pre-init |
| `surface` | `string` | cli, repl, daemon, telegram, subagent, web, sdk |
| `parentSessionId` | `string \| null` | Non-null for forked subagents |
| `depth` | `number \| null` | Nesting depth; null at top level |
| `maxDepth` | `number \| null` | Hard ceiling for agent/skill recursion |
| `phaseRole` | `string \| null` | `read-only` or `read-write`; null when not enforced |
| `cwd` | `string` | Working directory (worktree path under `-w`) |
| `model` | `{provider, name}` | Resolved provider and model identifier |
| `permissionMode` | `string` | `elevated` (bypass/auto-accept) or `default` (prompted) |

### `tools`

Tool affordances visible to the agent:

| Field | Type | Notes |
|-------|------|-------|
| `enabled` | `string[]` | Canonical tool names the dispatcher accepts (incl. `mcp__` prefixed) |
| `mcpServers` | `{name, toolCount}[]` | Connected MCP servers |
| `failedServers` | `{name, reason}[]` | MCP servers that failed to connect |

### `subagents`

Active child agents and background jobs:

| Field | Type | Notes |
|-------|------|-------|
| `foreground` | `{id, status}[]` | Active foreground subagent handles |
| `background` | `{jobId, status, startedAt, label}[]` | Background jobs |

### `workspace`

Git state gathered from `cwd`:

| Field | Type | Notes |
|-------|------|-------|
| `branch` | `string \| null` | Current branch; null on detached HEAD |
| `headSha` | `string \| null` | Short (7-char) HEAD SHA |
| `dirty` | `boolean \| null` | Whether working tree has changes |
| `dirtyCount` | `number \| null` | Number of dirty files |
| `remoteUrl` | `string \| null` | Origin remote URL |

### `hooks`

Merged disk hook configuration. **Opt-in only** (excluded from `all` to avoid extra disk I/O):

| Field | Type | Notes |
|-------|------|-------|
| `event` | `string` | Hook event name (PreToolUse, PostToolUse, etc.) |
| `matcher` | `string` | Tool/pattern matcher |
| `type` | `string` | Shell, builtin, etc. |
| `timeout` | `number` | Resolved timeout in ms |

Does not list live registrations or builtins; reads disk config only.

### `all`

Union of `self` + `tools` + `subagents` + `workspace` + usage (if enabled) + clock + subagentOutcomeSummary. Excludes `hooks`.

## Null semantics

Fields the runtime does not know are reported as `null` rather than synthesized defaults, so the model can distinguish "unknown" from "zero" or "empty". A top-level session has `depth: null` and `parentSessionId: null`; a subagent has concrete values for both.

## Source

`src/agent/awareness/tool.ts` (tool handler), `src/agent/awareness/types.ts` (type definitions), `src/agent/awareness/runtime-snapshot.ts` (snapshot builder), `src/agent/awareness/workspace-source.ts` (git gatherer).
