/**
 * MCP (Model Context Protocol) client integration — shared types.
 *
 * `McpServerConfig` is the JSON shape users write in
 * `~/.afk/config/mcp.json` (and project-local `<cwd>/.mcp.json` in a later
 * PR). The schema deliberately mirrors Claude Code's `mcpServers` block so
 * users can copy existing configs without translation.
 *
 * `McpClientState` is the runtime snapshot surfaced by `McpManager` to
 * the `/mcp` slash command and to provider session-init events.
 *
 * @module agent/mcp/types
 */

/**
 * Transport variants supported by the MCP client.
 *
 * - `stdio` — spawn a local subprocess and speak JSON-RPC over stdin/stdout.
 *   The dominant transport today. PR 1 ships this.
 * - `streamable-http` — modern remote transport (HTTP POST + SSE upgrade).
 *   Lands in PR 2.
 * - `sse` — legacy transport, deprecated upstream. Fallback probe in PR 2.
 */
export type McpTransportType = 'stdio' | 'streamable-http' | 'sse';

/**
 * Per-server configuration entry under the `mcpServers` map.
 *
 * Fields are intentionally loose so the JSON-schema validator at load time
 * can surface user-friendly errors (e.g. "stdio server missing `command`")
 * without TypeScript needing discriminated unions.
 */
export interface McpServerConfig {
  /**
   * Transport class. Defaults are inferred when omitted:
   *   - `command` present → `stdio`
   *   - `url` present → `streamable-http`
   * Explicitly setting `type` overrides the inference.
   */
  type?: McpTransportType;

  // ── stdio ─────────────────────────────────────────────────────────
  /** Executable to spawn. Required when `type === 'stdio'`. */
  command?: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /**
   * Environment variables for the spawned process.
   *
   * Values may contain `${VAR}` placeholders — these are expanded from
   * `process.env` at connect time (never via shell-eval). Unset variables
   * are passed through as the empty string and logged as a warning so the
   * server fails loudly with a missing-credential error rather than
   * silently inheriting the wrong identity.
   */
  env?: Record<string, string>;

  // ── http / sse ────────────────────────────────────────────────────
  /** Endpoint URL. Required when `type` is `streamable-http` or `sse`. */
  url?: string;
  /**
   * Extra HTTP headers. Values support `${VAR}` expansion just like `env`.
   * Use this for static bearer tokens: `{ Authorization: "Bearer ${TOKEN}" }`.
   */
  headers?: Record<string, string>;
  /**
   * When true, run the SDK's OAuth flow against this endpoint. The flow
   * surfaces the authorization URL via the existing Telegram push primitive
   * (`pushIfConfigured`) when running headless, or via stdout in the REPL.
   * Tokens are persisted in the macOS keychain under the `mcpOAuth` service.
   *
   * Lands in PR 2.
   */
  oauth?: boolean;

  // ── behaviour ─────────────────────────────────────────────────────
  /**
   * When true, skip this server entirely. Useful for temporarily disabling
   * a server without removing its config block.
   */
  disabled?: boolean;
  /**
   * When true, a failed connect attempt aborts session initialization with
   * the connect error. When false/unset (default), the failure is logged,
   * the server is marked `error` in `/mcp` status, and the session
   * continues with the remaining servers.
   */
  alwaysLoad?: boolean;
  /**
   * Request timeout in milliseconds (default 30_000). Applies to both
   * `tools/list` and `tools/call` requests.
   */
  timeout?: number;
}

/**
 * Lifecycle states for an MCP server connection.
 *
 * - `connecting` — `client.connect()` is in flight.
 * - `connected` — handshake complete, `tools/list` succeeded, handlers are
 *   registered with the session dispatcher.
 * - `error` — connect or initial `tools/list` failed. The error message is
 *   surfaced in `/mcp` and the server contributes no tools.
 * - `disabled` — user set `disabled: true` in config.
 * - `oauth_pending` — auth URL emitted but not yet completed (PR 2).
 */
export type McpClientStatus =
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disabled'
  | 'oauth_pending';

/**
 * Snapshot of a single MCP client's state at a point in time. Mutated by
 * `McpManager` as connections transition; consumers (the `/mcp` slash
 * command, `ProviderMcpServerStatus[]` reporters) read by reference.
 *
 * Intentionally a plain interface (not a class) so JSON serialization for
 * the daemon state file works without custom serializers.
 */
export interface McpClientState {
  /** User-facing name from the `mcpServers` map key. */
  serverName: string;
  /** Sanitized config (with `${VAR}` expansion NOT applied — secrets stay out). */
  config: McpServerConfig;
  /** Current lifecycle state. */
  status: McpClientStatus;
  /** Human-readable error when `status === 'error'`. Truncated to ~200 chars. */
  error?: string;
  /** Count of tools the server exposed at `tools/list` time. */
  toolCount: number;
  /** Wallclock timestamp of the last successful `tools/list` (ms since epoch). */
  lastListedAt?: number;
}
