# Agent Client Protocol (ACP) — `afk acp`

`afk acp` starts a JSON-RPC 2.0 server over **stdio** that lets Zed, JetBrains,
Cursor, Cline, Goose, OpenCode, and any other
[ACP](https://github.com/i-am-bee/acp)-compatible editor frontend drive afk as a
first-class agent backend — no editor plugin required.

## Quick start

```bash
afk acp
```

That's it. The server reads newline-delimited JSON (NDJSON) from **stdin** and
writes NDJSON to **stdout**.  All existing afk wiring — tools, hooks, memory,
skills, state — is inherited automatically.

### Options

| Flag | Default | Description |
|---|---|---|
| `-m, --model <model>` | configured default | Model to use for every session |
| `--max-turns <n>` | `10` | Maximum agent turns per `session/prompt` call |
| `--dangerously-skip-permissions` | off | Bypass all permission prompts (use only in trusted environments) |

## Wire format

NDJSON over stdio: one JSON object per line in both directions.

Requests follow [JSON-RPC 2.0](https://www.jsonrpc.org/specification).
Intermediate streaming frames are JSON-RPC **notifications** (no `id` field);
the final response for each request carries the original `id`.

### Supported methods

| Method | Description |
|---|---|
| `initialize` | Capability handshake — must be called first |
| `session/new` | Create a named session; returns `{ sessionId }` |
| `session/prompt` | Stream a prompt; emits `session/update` notifications then a `done` response |
| `session/cancel` | Abort a running `session/prompt` through `AbortGraph` |
| `session/close` | Tear down a session and release its resources |

### Error codes

Standard JSON-RPC 2.0 codes plus one ACP-specific code:

| Code | Meaning |
|---|---|
| `-32700` | Parse error (malformed JSON or request > 1 MiB) |
| `-32600` | Invalid request (missing `jsonrpc`/`method`, or called before `initialize`) |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error (details logged to stderr, not forwarded to client) |
| `-32001` | Cancelled (prompt was aborted via `session/cancel`) |

## Session lifecycle

```
client → server
──────────────────────────────────────────────────────────────────────────────
{"jsonrpc":"2.0","id":1,"method":"initialize"}

server → client
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"1.0",
  "agentCapabilities":{"streaming":true,"methods":["initialize","session/new","session/prompt","session/close","session/cancel"]},
  "serverInfo":{"name":"afk","version":"acp/1.0"}
}}

client → server
{"jsonrpc":"2.0","id":2,"method":"session/new"}

server → client
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"<uuid>"}}

client → server
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<uuid>","prompt":"Hello"}}

server → client  (notifications — no id)
{"jsonrpc":"2.0","method":"session/update","params":{"type":"update","update":{"type":"text_delta","delta":"Hi"},"sessionId":"<uuid>"}}
{"jsonrpc":"2.0","method":"session/update","params":{"type":"update","update":{"type":"tool_start","toolName":"bash"},"sessionId":"<uuid>"}}
{"jsonrpc":"2.0","method":"session/update","params":{"type":"update","update":{"type":"tool_end","toolName":"bash"},"sessionId":"<uuid>"}}
...

server → client  (final response — carries the request id)
{"jsonrpc":"2.0","id":3,"result":{"type":"done","update":{"type":"done","costUsd":0.003},"text":"Hi …"}}

client → server
{"jsonrpc":"2.0","id":4,"method":"session/close","params":{"sessionId":"<uuid>"}}

server → client
{"jsonrpc":"2.0","id":4,"result":{"closed":true}}
```

### `session/update` notification shapes

| `update.type` | Extra fields | Description |
|---|---|---|
| `text_delta` | `delta: string` | Incremental assistant text |
| `tool_start` | `toolName: string` | Tool call beginning |
| `tool_end` | `toolName: string` | Tool call finished |
| `rate_limit` | `retryAfterMs: number` | Provider rate-limit; server will retry automatically |
| `done` | `sessionId?`, `costUsd?` | Matches the final response result |

### Multi-turn sessions

Sessions are stateful: subsequent `session/prompt` calls on the same `sessionId`
continue the conversation with full context.

### Prompt as content blocks

`params.prompt` accepts either a plain string or an array of ACP content blocks:

```json
{"type":"text","text":"Hello"}
```

Text blocks are concatenated in order; non-text blocks are ignored.

### Per-session working directory

Pass `cwd` in `session/new` params to pin the session to a subdirectory of the
server's working directory:

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/path/to/project"}}
```

`cwd` must exist, be a directory, and be at or below `process.cwd()` when the
server started (path-traversal guard).

## Cancellation

Send `session/cancel` while a `session/prompt` is in flight to abort it:

```json
{"jsonrpc":"2.0","id":10,"method":"session/cancel","params":{"sessionId":"<uuid>"}}
```

The server signals the running turn via `AbortGraph`, drains any in-flight work,
and responds to the `session/prompt` with error code `-32001` (`Cancelled`).
The `session/cancel` response itself returns `{"cancelled":true}`.

## Configuring editors

### Zed

In your Zed `settings.json`, add afk as a custom agent under
`"assistant" > "version": "2"`:

```json
{
  "assistant": {
    "version": "2",
    "default_model": {
      "provider": "custom",
      "model": "afk"
    },
    "custom_models": [
      {
        "name": "afk",
        "provider": "acp",
        "command": "afk",
        "args": ["acp"],
        "max_tokens": 8192
      }
    ]
  }
}
```

Restart Zed. Open the Assistant panel and select **afk** from the model picker.
Multi-turn conversation, tool-call progress, and permission prompts all work
through the ACP channel.

### JetBrains (AI Assistant plugin ≥ 2025.1)

1. Open **Settings → Tools → AI Assistant → Custom Agents**.
2. Click **+** and fill in:
   - **Name:** `afk`
   - **Transport:** `stdio`
   - **Command:** `afk acp`
3. Click **OK** and restart the IDE.
4. In any editor, open the AI chat panel, click the model picker, and choose
   **afk**.

### Cursor

```bash
# ~/.cursor/mcp.json  (or the workspace .cursor/mcp.json)
{
  "mcpServers": {
    "afk-acp": {
      "command": "afk",
      "args": ["acp"],
      "transport": "stdio"
    }
  }
}
```

### Cline CLI

```bash
cline --agent afk --agent-transport stdio --agent-command "afk acp"
```

### Goose

```yaml
# ~/.config/goose/config.yaml
agents:
  - name: afk
    transport: stdio
    command: afk acp
```

## Permissions

By default, afk runs in `default` permission mode: tool calls that require
user approval will surface a permission prompt.  In headless / CI environments
you can bypass all prompts:

```bash
afk acp --dangerously-skip-permissions
```

> **Warning:** this flag bypasses all safety gates.  Only use it in trusted,
> sandboxed environments where the agent has been granted the relevant
> permissions out-of-band.

## Testing manually

```bash
# One-liner smoke test (requires jq)
printf '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"session/new"}\n' \
  | afk acp | jq .
```

## Implementation notes

The ACP adapter is split across four files to stay under the 350-line ceiling:

| File | Role |
|---|---|
| `src/cli/commands/acp.ts` | Commander registration (~58 LOC) |
| `src/cli/commands/acp.server.ts` | JSON-RPC 2.0 stdio loop + method dispatch |
| `src/cli/commands/acp.server.protocol.ts` | Wire-format types, error codes, write helpers |
| `src/cli/commands/acp.session.ts` | `AgentSession` construction and teardown |

See also: [`docs/headless.md`](headless.md) for the lower-level `afk chat --format stream-json` surface.
