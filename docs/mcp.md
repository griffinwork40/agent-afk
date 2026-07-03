# MCP (Model Context Protocol)

`agent-afk` connects to MCP servers and bridges their tools into the running
session alongside built-ins. The config schema deliberately mirrors Claude
Code's `mcpServers` block so existing configs work without translation.

Implementation: `src/agent/mcp/` (`types.ts`, `config-loader.ts`, `client.ts`,
`transport.ts`, `manager.ts`, `naming.ts`, `oauth.ts`, `env.ts`).

## Configuring servers

Add a `mcpServers` map to `~/.afk/config/mcp.json` (user-global),
`<cwd>/.mcp.json` (project-local), or a file passed via `--mcp-config <path>`:

```jsonc
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}"
      }
    }
  }
}
```

### Schema (`McpServerConfig`)

| Field | Type | Notes |
|---|---|---|
| `type` | `"stdio" \| "streamable-http" \| "sse"` | Inferred when omitted: `command` present → `stdio`; `url` present → `streamable-http`. Explicit `type` overrides inference. |
| `command` | `string` | Executable to spawn. Required for `stdio`. |
| `args` | `string[]` | Arguments passed to `command`. |
| `env` | `Record<string,string>` | Env vars for the spawned process. Supports `${VAR}` expansion. |
| `url` | `string` | Endpoint URL. Required for `streamable-http`/`sse`. |
| `headers` | `Record<string,string>` | Extra HTTP headers, e.g. `{ "Authorization": "Bearer ${TOKEN}" }`. Supports `${VAR}` expansion. |
| `oauth` | `boolean` | Run the SDK OAuth flow against this endpoint. |
| `disabled` | `boolean` | Skip this server entirely without removing its config block. |
| `alwaysLoad` | `boolean` | `true`: a failed connect aborts session init with the connect error. `false`/unset (default): the failure is logged, the server is marked `error` in `/mcp`, and the session continues with the remaining servers. |
| `timeout` | `number` | Request timeout in ms (default `30_000`), applied to both `tools/list` and `tools/call`. |

### `${VAR}` environment expansion

`env` and `headers` values may contain `${VAR}` placeholders, expanded against
`process.env` at connect time — never via shell-eval, so there is zero
command-injection surface from config values. `$${VAR}` escapes to a literal
`${VAR}`. An unset variable expands to the empty string (passed through, not
omitted) and is logged as a warning, so the server fails loudly with its own
missing-credential error rather than silently inheriting the wrong identity.

## Config layering

Layers are read lowest → highest priority and merged **per server name**
(whole config blocks are atomic — no field-level merge). A name collision
logs a warning naming the displaced source; the higher layer's entry wins
outright:

0. Configs imported from trusted source binaries (e.g. Claude Code, via
   `afk migrate`) — lowest priority of all.
1. Plugin-contributed `<plugin>/.claude-plugin/mcp.json`.
2. `~/.afk/config/mcp.json` — user-global.
3. `<cwd>/.mcp.json` — project-local (auto-loaded; see Security below).
4. `--mcp-config <path>` — CLI override, highest priority. Still *merges*
   over the other layers rather than replacing them; to run fully isolated,
   put an empty `mcpServers: {}` in the user-global file and everything else
   in the `--mcp-config` file.

A missing file or `{}` is not an error. A malformed server entry (e.g. a
`stdio` block with no `command`) is skipped with a warning rather than
blocking the rest of the config.

## Transports

- **`stdio`** — spawns a local subprocess and speaks JSON-RPC over
  stdin/stdout. The default when `command` is set.
- **`streamable-http`** — HTTP POST + SSE upgrade; the default for a `url`-only
  entry.
- **`sse`** — legacy transport, deprecated upstream. Emits a stderr deprecation
  warning when selected explicitly.
- **SSE fallback probe** — when a `streamable-http` connection attempt gets
  HTTP 404 or 405 back, the client transparently retries with
  `SSEClientTransport` (matching upstream SDK guidance for legacy servers).
- **Plaintext guard** — remote URLs (`streamable-http`/`sse`) must be `https:`
  unless the host is loopback (`localhost`/`127.0.0.1`); non-loopback `http:`
  URLs are refused outright so bearer tokens, OAuth headers, and tool I/O
  never transit the network in cleartext.

## OAuth

Set `oauth: true` on a `streamable-http`/`sse` server to run the SDK's OAuth
flow against it. Tokens, client info, PKCE verifier, and discovery state are
persisted per-server under a `mcpOAuth` key inside the existing Claude Code
credentials store (macOS Keychain, or `~/.claude/.credentials.json` on
Linux) — no separate credential store.

When the server requires authorization, the URL is surfaced two ways:

- Pushed via Telegram if the bot is configured (`pushIfConfigured`).
- Otherwise written to stderr, and `~/.afk/state/mcp/server-status.json` is
  updated with an `oauth_pending` entry (server name, URL, timestamp) so it
  can be discovered later. Pending entries older than 10 minutes are treated
  as absent.

Complete the flow from the REPL with `/mcp auth complete <serverName> <code>`
after visiting the authorization URL.

## Tool naming and hooks

Every MCP tool is exposed to the model as `mcp__<server>__<tool>`
(`buildMcpToolName` in `naming.ts`), because Anthropic tool names must match
`^[a-zA-Z0-9_-]{1,64}$`. Both segments are sanitized (disallowed characters →
`_`, runs collapsed); if the joined name still exceeds 64 characters the
server segment is replaced with a 6-character SHA-256 prefix, and if it's
*still* too long the tool-name tail is truncated. Any resulting collision
across servers is surfaced as a hard startup error rather than silently
shadowing one tool.

MCP tools are merged into the same handler map the tool dispatcher
(`src/agent/tools/dispatcher.ts`) already uses for built-in tools, so
`PreToolUse`/`PostToolUse` hooks fire automatically for MCP tool calls exactly
like any other tool call — nothing extra to configure.

When a connected server sends `notifications/tools/list_changed`, the manager
calls `refreshServer()` so the *next* tool-call round sees the server's
updated tool list without restarting the session. Refresh failures are logged
and swallowed — the session degrades to the previous (stale) tool list rather
than crashing.

## `/mcp` and `/mcp auth`

- `/mcp` — lists connected servers with status, and flags how many are
  waiting on OAuth.
- `/mcp auth` — lists servers with a pending OAuth authorization (name, age,
  URL).
- `/mcp auth complete <serverName> <code>` — completes a pending flow using
  the code obtained from the authorization URL.

## Security

- **A server entry is arbitrary code execution.** `stdio` servers spawn
  whatever `command` says with the given `args`/`env`; treat `mcp.json`
  contents with the same trust level as a script you'd run yourself.
- **Project-local config auto-loads by default.** `<cwd>/.mcp.json` is read
  automatically, which can be a CWD-poisoning vector in shared or CI
  environments (a checked-out repo can add MCP servers to your session
  without prompting). Set `AFK_ALLOW_PROJECT_MCP=0` to disable this layer
  entirely; a warning naming the loaded path is emitted every time it fires.
- **No cleartext remote transports.** Non-loopback `streamable-http`/`sse`
  URLs must be `https:` (see Transports above).
- **No shell in `${VAR}` expansion.** Expansion reads `process.env` directly;
  it never invokes a shell or evaluates expressions.

## Worked example: Brave Search over stdio

```jsonc
// ~/.afk/config/mcp.json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}"
      }
    }
  }
}
```

Export `BRAVE_API_KEY` in your shell before starting `afk` — it's expanded
into the spawned process's env at connect time and never written back to the
sanitized config the session surfaces via `/mcp`. Once connected, its tools
appear on the wire as `mcp__brave-search__<tool>` and are callable like any
built-in tool, subject to the same `PreToolUse`/`PostToolUse` hooks and
permission gate.

## See also

- `src/agent/mcp/types.ts` — config schema types.
- `src/agent/mcp/config-loader.ts` — layered loader implementation.
- `src/agent/mcp/manager.ts` — connection lifecycle, tool bridging, hook wiring.
- `src/agent/mcp/transport.ts` — transport selection, SSE fallback, plaintext guard.
- `src/agent/mcp/oauth.ts` — OAuth provider, keychain storage, pending-auth surfacing.
- `src/agent/mcp/naming.ts` — wire tool-name encoding and collision detection.
- `docs/env-registry.md` — `AFK_ALLOW_PROJECT_MCP` and other env vars.
