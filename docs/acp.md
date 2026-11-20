# Agent Client Protocol (ACP): `afk acp`

`afk acp` starts a JSON-RPC 2.0 server over stdio that lets any
[ACP v1](https://agentclientprotocol.com) compatible front end drive AFK as an
agent backend. The previous home-grown wire format is removed in this release;
see [CHANGELOG](../CHANGELOG.md) for the migration note.

The server reads newline-delimited JSON (NDJSON) from stdin and writes NDJSON
to stdout. All AFK wiring, tools, hooks, memory, skills, and state, is inherited
automatically.

> **Note for implementers:** this page is the user guide. The full wire contract,
> field-level types, permission decision table, and seam specifications are in
> [`docs/acp-profile.md`](acp-profile.md).

## Quick start

```bash
afk acp
```

## Flags

| Flag | Default | Description |
|---|---|---|
| `-m, --model <model>` | configured default | Model for every session created by this server |
| `--max-turns <n>` | `10` | Maximum agent turns per `session/prompt` call |
| `--dangerously-skip-permissions` | off | Skip all permission prompts for every session on this server (see [Permissions](#permissions)) |

## What AFK currently supports on this surface

- Anthropic models only. The model provider is fixed on the ACP surface; the
  `--model` flag selects a Claude model. This restriction is tracked in
  open question Q-B of the profile.
- Text and embedded-context prompts (`embeddedContext: true`).
- Streaming tool-call progress with diffs for edit operations.
- Interactive permission approvals, with allow-once and allow-always (not for
  `bash`), and reject.
- Session load, replay, and resume.
- Writes are confined to the session `cwd` and its descendants. A path outside
  that directory is denied; there is no GUI path-approval bridge.
- Approving a delegation tool (`agent`, `skill`, `compose`, `remote_agent`)
  is a single consent covering what that subagent does without further GUI
  prompts. The subagent still observes its own tool allowlist and path
  restrictions.

**Not yet supported:** image or audio input blocks; HTTP or SSE MCP transports;
additional workspace directories; system-prompt override; session listing or
deletion; ACP plan mode; model fallback for the ACP surface.

## Connection and initialization

Send `initialize` once before any session method. `protocolVersion` must be an
integer. AFK supports version 1 only and always returns `1`, including when the
client offers a different version.

Golden transcript (from `tests/fixtures/acp/transcripts/text-turn.ndjson`):

```jsonc
// client
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"my-client","version":"1.0.0"}}}

// server
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"afk","title":"AFK","version":"6.0.0"},"authMethods":[],"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},"mcpCapabilities":{"http":false,"sse":false},"sessionCapabilities":{"resume":{},"close":{}}}}}
```

`agentInfo.version` is the running package version. Credentials are configured
on the host running AFK, outside ACP. There is no authentication flow.

## Session lifecycle

### Create a session

`session/new` takes required `cwd` and `mcpServers`. `cwd` must be an absolute
path to an existing directory at or below the server's launch directory.
`mcpServers` is an array of stdio MCP entries, each with `name`, `command`
(absolute path), `args`, and `env`. HTTP and SSE entries are rejected. An empty
array is valid.

```jsonc
// client
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/workspace","mcpServers":[]}}

// server
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"11111111-1111-4111-8111-111111111111"}}
```

The `sessionId` is an opaque UUID. Store it unchanged; never derive a path from it.

### Send a prompt

`session/prompt` takes `sessionId` and `prompt` as an array of content blocks.
Text blocks are the most common:

```json
{"type":"text","text":"Hello"}
```

Resource link blocks provide a name and URI reference. Resource blocks with
embedded text inline their content. Image and audio blocks are invalid on this
surface. At most one prompt may be active per session at a time.

A complete text-only exchange (abbreviated from `text-turn.ndjson`):

```jsonc
// client
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"11111111-1111-4111-8111-111111111111","prompt":[{"type":"text","text":"Hello"}]}}

// server (notification, no id)
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"11111111-1111-4111-8111-111111111111","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"I will greet the user."}}}}

// server (notification)
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"11111111-1111-4111-8111-111111111111","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello!"}}}}

// server (usage update, notification)
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"11111111-1111-4111-8111-111111111111","update":{"sessionUpdate":"usage_update","used":1024,"size":200000,"cost":{"amount":0.01,"currency":"USD"}}}}

// server (final response, carries request id)
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

The final response contains only `stopReason`. Possible values: `end_turn`,
`max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. Provider and session
errors return a JSON-RPC error response with code `-32603`.

Sessions are stateful. Subsequent `session/prompt` calls on the same `sessionId`
continue the conversation with full context.

### Close a session

```jsonc
// client
{"jsonrpc":"2.0","id":4,"method":"session/close","params":{"sessionId":"11111111-1111-4111-8111-111111111111"}}

// server
{"jsonrpc":"2.0","id":4,"result":{}}
```

Closing an already-closed or unknown session also returns `{}`.

## Output updates

All updates are `session/update` notifications with this envelope:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"..."}}}
```

| `sessionUpdate` | Fields | Description |
|---|---|---|
| `agent_message_chunk` | `content: {type:"text",text}` | Incremental assistant text |
| `agent_thought_chunk` | `content: {type:"text",text}` | Provider reasoning, only when available |
| `user_message_chunk` | `content: {type:"text",text}` | During session replay only |
| `tool_call` | `toolCallId`, `title`, `name`, `kind`, `status`, `rawInput`, `content`, `locations` | First announcement of a tool call |
| `tool_call_update` | `toolCallId`, changed fields | Status change or result accumulation |
| `usage_update` | `used`, `size`, optional `cost` | Context tokens used and window size |

`used` is the current context-window token count. `size` is the model's context
window. `cost.amount` is the cumulative session cost in USD when available.

## Tool calls, kinds, and diffs

The `kind` field classifies the tool's intent:

| Kind | Examples |
|---|---|
| `read` | `read_file`, `list_directory`, `grep`, `glob` |
| `edit` | `write_file`, `edit_file`, `patch_apply` |
| `execute` | `bash`, `test_run` |
| `fetch` | `web_scrape`, `web_request` |
| `search` | `memory_search`, `workspace_query` |
| `think` | `agent`, `skill`, `compose`, `remote_agent` |
| `other` | everything else, including all MCP tools |

Delegation tools (`agent`, `skill`, `compose`, `remote_agent`) append
` (subagent will act without further prompts)` to their title.

A read tool auto-starts at `in_progress`. A write or other consent-requiring
tool starts at `pending` and waits for a permission decision before moving to
`in_progress`. After execution, a terminal `tool_call_update` sets `status` to
`completed` or `failed`.

Edit tools emit diff content items alongside text results. Each diff has this
shape:

```json
{"type":"diff","path":"/absolute/path","oldText":"old line","newText":"new line"}
```

A complete edit-with-diff exchange (abbreviated from `tool-edit-diff.ndjson`):

```jsonc
// server: announces tool call pending permission
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"tool_call","toolCallId":"tool-1","title":"edit_file /workspace/a.txt","name":"edit_file","kind":"edit","status":"pending","rawInput":{"file_path":"/workspace/a.txt","old_string":"old","new_string":"new"},"content":[],"locations":[{"path":"/workspace/a.txt"}]}}}

// server: requests permission (agent-to-client request, has id)
{"jsonrpc":"2.0","id":"acp:1","method":"session/request_permission","params":{"sessionId":"...","toolCall":{...},"options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},{"optionId":"allow_always","name":"Always allow edit_file in this session","kind":"allow_always"},{"optionId":"reject_once","name":"Reject","kind":"reject_once"}]}}

// client: approves
{"jsonrpc":"2.0","id":"acp:1","result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}

// server: transitions to in_progress
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"in_progress"}}}

// server: emits diff
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","content":[{"type":"diff","path":"/workspace/a.txt","oldText":"old","newText":"new"}]}}}

// server: completes with result, diff carried forward
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed","rawOutput":"Replaced 1 occurrence","content":[{"type":"diff","path":"/workspace/a.txt","oldText":"old","newText":"new"},{"type":"content","content":{"type":"text","text":"Replaced 1 occurrence"}}]}}}
```

Note that `ToolCallUpdate.content` replaces the whole collection. The server
carries earlier diffs forward in each subsequent update so the final result
does not erase a displayed diff.

## Permissions

Approvals are on by default. The server sends `session/request_permission`
(an agent-to-client request with an `acp:N` id) before executing any tool that
requires consent.

| Tool class | Decision |
|---|---|
| Read and search tools | Auto-allow |
| `worktree` with action `list` | Auto-allow |
| Write tools, `bash`, `test_run`, web tools, delegation tools, MCP tools, unknown tools | Ask |
| `--dangerously-skip-permissions` | Skip the bridge entirely |

`options` always includes `allow_once` and `reject_once`. `allow_always` is
offered for every tool except `bash`. An `allow_always` grant applies to that
exact tool name for the rest of the live session only. It is not persisted.

Respond with the `outcome` field:

```jsonc
// allow once
{"jsonrpc":"2.0","id":"acp:1","result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}

// reject
{"jsonrpc":"2.0","id":"acp:1","result":{"outcome":{"outcome":"selected","optionId":"reject_once"}}}

// cancel the whole turn
{"jsonrpc":"2.0","id":"acp:1","result":{"outcome":{"outcome":"cancelled"}}}
```

A cancelled outcome stops the turn with `stopReason: "cancelled"`. A rejected
tool returns a failed `tool_call_update` with text `Permission denied: rejected`;
the model may continue. Unanswered requests time out after 120 seconds with an
explicit deny.

When you cancel during an outstanding permission request (from
`cancel-during-permission.ndjson`):

```jsonc
// client sends cancel notification AND answers the pending permission with cancelled
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"..."}}
{"jsonrpc":"2.0","id":"acp:1","result":{"outcome":{"outcome":"cancelled"}}}

// server: tool fails
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"failed","rawOutput":"Permission denied: cancelled","content":[{"type":"content","content":{"type":"text","text":"Permission denied: cancelled"}}]}}}

// server: prompt ends cancelled
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"cancelled"}}
```

**The `--dangerously-skip-permissions` flag is a server-wide setting.** Every
session on this server runs without permission prompts. Use only in a trusted,
externally sandboxed environment. The flag provides no sandbox of its own.

## Cancellation

`session/cancel` is a notification (no `id`, no response):

```json
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"..."}}
```

For an active turn, the server stops model and tool work, flushes final updates,
and resolves the prompt with `stopReason: "cancelled"`. The client must answer
any pending permission request with the cancelled outcome when cancelling (see
example above). Cancellation of an idle or unknown session is a no-op.

Cancel during streaming (from `cancel-during-stream.ndjson`):

```jsonc
// server already streaming
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}

// client cancels
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"..."}}

// server resolves the prompt
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"cancelled"}}
```

## Load and resume

`session/load` restores a saved session by `sessionId`, replays its human-visible
history as `session/update` notifications, and returns `{}`. It requires `cwd`
and `mcpServers`. Replay uses `user_message_chunk`, `agent_message_chunk`, and
terminal `tool_call` entries. Historical tools are never re-executed.

`session/resume` restores without replay and returns `{}`. `mcpServers` is
optional on resume; omitting it is equivalent to an empty array.

Both methods return `{"code":-32002,"message":"Resource not found"}` for unknown
session ids, and `{"code":-32600,"message":"Invalid request"}` if the session is
already active.

## Version negotiation

AFK returns `protocolVersion: 1` regardless of the integer the client requests.
A client that cannot use version 1 should disconnect. A string such as `"1.0"`
is invalid params (from `bad-version-negotiation.ndjson`):

```jsonc
// client offers version 0
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":0}}

// server: returns 1
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,...}}
```

## Error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error (malformed JSON or line exceeds 1 MiB) |
| `-32600` | Invalid request (bad envelope, duplicate initialize, session method before initialize, duplicate active prompt) |
| `-32601` | Method not found |
| `-32602` | Invalid params (bad cwd, unsupported block type, unsupported MCP transport, nonempty additional roots, non-null system prompt) |
| `-32002` | Resource not found (unknown session id) |
| `-32603` | Internal error (provider or session failure; details logged to stderr only) |

There is no `-32001` cancellation error. Cancellation produces a successful
response with `stopReason: "cancelled"`.

## Transport rules

One JSON object per line. Stdout carries protocol frames only; diagnostics go to
stderr. Lines over 1,048,576 bytes are discarded and reported as invalid requests.
Empty lines are ignored. Invalid UTF-8 and invalid JSON are parse errors. EOF
cancels and releases every live session.

## Connecting a client

Any client that implements ACP v1 can connect to `afk acp`.

For **Zed**, register AFK as a custom agent. Open Agent Settings (`agent: open settings`),
go to the External Agents page, click Add Agent, then Add Custom Agent. Add this
entry to the `agent_servers` block in your Zed settings file
(`~/.config/zed/settings.json` on macOS and Linux):

```json
{
  "agent_servers": {
    "afk": {
      "type": "custom",
      "command": "afk",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

After saving, AFK appears in the new-thread menu in the Agent Panel and Threads
Sidebar. Zed does not charge for external agents. Auth, model selection, and
billing are owned by AFK. See [Zed's External Agents documentation](https://zed.dev/docs/ai/external-agents)
(verified 2026-11-20) for the full setup path and registry installation.

For other clients, follow the client's documentation for registering a custom
ACP v1 agent that runs `afk acp` over stdio.

## Smoke test

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"test","version":"0"}}}\n{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"'"$(pwd)"'","mcpServers":[]}}\n' \
  | afk acp
```

## See also

- [`docs/acp-profile.md`](acp-profile.md): full wire contract for implementers
- [`docs/headless.md`](headless.md): lower-level `afk chat --format stream-json` surface
- [`tests/fixtures/acp/transcripts/`](../tests/fixtures/acp/transcripts/): golden NDJSON transcripts
