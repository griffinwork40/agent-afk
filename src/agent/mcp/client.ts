/**
 * Wrapper around a single `@modelcontextprotocol/sdk` Client instance.
 *
 * Owns one transport (stdio, streamable-HTTP, or SSE), advertises a
 * deliberately narrow ClientCapabilities surface, and exposes a small
 * ergonomic API for the `McpManager` to consume:
 *
 *   - `connect()`            — spawn transport, hand to Client, await handshake
 *   - `listTools()`          — proxy to `client.listTools()`
 *   - `callTool(name, args)` — invoke a tool, normalize result into the
 *     project's `ToolResult` shape
 *   - `disconnect()`         — best-effort tear-down
 *
 * Capabilities choices (per the /gather Q2 finding):
 *   - We do NOT advertise `sampling` capability. Sampling-dependent server
 *     tools therefore won't appear in `tools/list`, eliminating the "stub
 *     or hang" footgun for MVP. Reverse-direction `sampling/createMessage`
 *     requests, if a server sends one anyway, are logged at debug and
 *     declined via the SDK's default behaviour.
 *   - We do NOT advertise `elicitation` capability in PR 2. The bridge to
 *     the existing `routeElicitation()` router is a follow-up once remote
 *     server integration is stable.
 *
 * Transport selection (PR 2+):
 *   - `stdio` (default when `command` is set) — unchanged from PR 1.
 *   - `streamable-http` (default when `url` is set) — connects via HTTP POST
 *     + SSE upgrade. Attempts this transport first; if the server responds
 *     with 404 or 405, falls back to the legacy SSE transport.
 *   - `sse` (explicit) — deprecated upstream; emits a warning.
 *   - `oauth: true` — a `KeychainOAuthProvider` is wired into the transport
 *     before `Client.connect()`. The SDK handles token refresh internally;
 *     when no tokens exist the provider fires `redirectToAuthorization` which
 *     routes the auth URL via Telegram or stderr.
 *
 * @module agent/mcp/client
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import type { ToolResult } from '../tools/types.js';
import type { McpServerConfig } from './types.js';
import { createTransport } from './transport.js';
import { KeychainOAuthProvider } from './oauth.js';

/** Client identity advertised in the MCP handshake. */
const CLIENT_INFO = {
  name: 'agent-afk',
  // Kept in sync with package.json on a best-effort basis; not a load-bearing
  // value (servers never gate on this).
  version: '2.x',
} as const;

/**
 * The capability set agent-afk advertises during the MCP handshake.
 *
 * Note the deliberate omission of `sampling` and `elicitation` — see the
 * module docstring.
 */
const CLIENT_CAPABILITIES = {
  // Empty object signals "we participate in the handshake but advertise no
  // optional capabilities". The SDK still negotiates protocol-level things
  // like progress notifications automatically.
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;

export interface McpClientConnectResult {
  /** Tools the server exposed at first `tools/list`. */
  tools: McpTool[];
  /** Server's reported `{ name, version }` from the handshake. */
  serverInfo: { name: string; version: string } | undefined;
}

/**
 * Wraps a single MCP client connection. One instance per configured server.
 *
 * Lifecycle: `connect()` → `listTools()` / `callTool()` (any number) →
 * `disconnect()`. The wrapper is NOT re-entrant; create a fresh instance
 * if you need to reconnect after `disconnect()`.
 */
export class McpClient {
  private readonly serverName: string;
  private readonly config: McpServerConfig;
  private client: Client | undefined;
  private connected = false;
  /**
   * The transport retained when connect() throws `UnauthorizedError` (OAuth
   * pending). Kept so `finishAuth()` can be called by `/mcp auth complete`
   * after the user has authorized in a browser. Cleared on successful
   * reconnect or `disconnect()`.
   */
  private pendingAuthTransport:
    | import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport
    | import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport
    | undefined;

  /**
   * Called when the transport surfaces an unrecoverable error AFTER initial
   * connect succeeded. Lets the manager downgrade status to `error` and
   * surface the failure in `/mcp` without crashing the session.
   */
  onTransportError?: (err: Error) => void;

  /**
   * Called when the server sends `notifications/tools/list_changed`.
   * Manager re-fetches `tools/list` and updates the dispatcher's handler
   * map in place (PR 3 wires this end-to-end; PR 1 stubs the handler).
   */
  onToolListChanged?: () => void;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  /**
   * Connect to the MCP server. Throws on transport failure, handshake
   * timeout, or unrecoverable OAuth error. On success returns the initial
   * tool list and server identity from the handshake.
   *
   * Transport selection and SSE fallback probe:
   *   1. Build the primary transport via `createTransport()`.
   *   2. Attempt `Client.connect()`.
   *   3. If the server replies 404 or 405 (StreamableHTTPError with those
   *      codes), fall back to SSE and retry once.
   *
   * OAuth flow:
   *   When `config.oauth === true`, a `KeychainOAuthProvider` is wired into
   *   the transport. The SDK calls `redirectToAuthorization` internally when
   *   no valid token exists; `KeychainOAuthProvider` routes the URL via
   *   Telegram push (or stderr) and throws `UnauthorizedError`. The manager
   *   catches this and sets `status: 'oauth_pending'` rather than `'error'`.
   */
  async connect(): Promise<McpClientConnectResult> {
    if (this.connected) {
      throw new Error(`McpClient(${this.serverName}): already connected`);
    }

    // Build the OAuth provider when requested. It is created once and shared
    // between the primary transport and any SSE fallback.
    const oauthProvider = this.config.oauth === true
      ? new KeychainOAuthProvider(this.serverName)
      : undefined;

    const { primary, fallback } = buildTransportPair(
      this.serverName,
      this.config,
      oauthProvider,
    );

    const client = new Client(CLIENT_INFO, { capabilities: CLIENT_CAPABILITIES });

    // Wire transport-level error reporting so the manager can downgrade
    // status without the process crashing.
    primary.transport.onerror = (err) => {
      this.onTransportError?.(err);
    };

    // `notifications/tools/list_changed` — fire-and-forget callback into
    // the manager. We register via setNotificationHandler so the SDK
    // dispatches correctly even when the server sends the notification
    // before we've called listTools() a second time.
    //
    // PR 3 wires the refresh path end-to-end; for now we just record that
    // the server is participating.
    try {
      const { ToolListChangedNotificationSchema } = await import(
        '@modelcontextprotocol/sdk/types.js'
      );
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.onToolListChanged?.();
      });
    } catch {
      // Defensive: schema import is best-effort. The notification will
      // simply be ignored if the schema can't be loaded.
    }

    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;

    // Constraint: connect attempt order is semantically governed — primary
    // must fail before fallback is tried. Emit both as sequential awaits,
    // never concurrent.
    let usedSSE = primary.isSSE;
    // `activeClient` is `client` on the happy path; replaced with a fresh
    // `Client` instance in the SSE fallback branch to avoid the SDK guard
    // "Already connected to a transport" (the SDK sets an internal transport
    // reference before a failed connect, so re-calling connect() on the same
    // instance always throws — even after a transport-level error).
    let activeClient = client;
    try {
      await withTimeout(
        client.connect(primary.transport),
        timeoutMs,
        () => new Error(`MCP server "${this.serverName}" connect timed out after ${timeoutMs}ms`),
        // Close the transport on timeout so the underlying socket / child
        // process / SSE stream is reaped instead of leaking until GC.
        () => primary.transport.close().catch(() => undefined),
      );
    } catch (err) {
      // SSE fallback probe: 404/405 from streamable-HTTP → retry with SSE.
      if (isHttpFallbackError(err) && fallback !== null) {
        console.warn(
          `[mcp:${this.serverName}] streamable-HTTP got ${httpErrorCode(err)}; ` +
          `falling back to SSE transport`,
        );
        const sseResult = fallback();
        sseResult.transport.onerror = (e) => {
          this.onTransportError?.(e);
        };
        // Fresh Client instance — the primary `client` already has an internal
        // transport reference from the failed streamable-HTTP attempt and
        // cannot be reused without triggering the SDK's "Already connected"
        // guard. A new instance is cleaner than awaiting close() first.
        const sseClient = new Client(CLIENT_INFO, { capabilities: CLIENT_CAPABILITIES });
        try {
          const { ToolListChangedNotificationSchema } = await import(
            '@modelcontextprotocol/sdk/types.js'
          );
          sseClient.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            this.onToolListChanged?.();
          });
        } catch {
          // Best-effort, same as the primary registration above.
        }
        await withTimeout(
          sseClient.connect(sseResult.transport),
          timeoutMs,
          () => new Error(`MCP server "${this.serverName}" (SSE fallback) connect timed out after ${timeoutMs}ms`),
          () => sseResult.transport.close().catch(() => undefined),
        );
        activeClient = sseClient;
        usedSSE = true;
      } else if (err instanceof UnauthorizedError) {
        // OAuth pending: retain the transport so finishAuth() can be called
        // later via `/mcp auth complete <server> <code>`. The transport holds
        // the PKCE state and token-endpoint URL needed to exchange the code.
        // Cast is safe: stdio transports never reach this branch (they don't
        // implement OAuth); only SSE and streamable-HTTP transports do.
        this.pendingAuthTransport = primary.transport as typeof this.pendingAuthTransport;
        throw err;
      } else {
        throw err;
      }
    }

    if (usedSSE && !primary.isSSE) {
      // Emit deprecation warning once the fallback succeeded (not before,
      // because if primary had succeeded we'd never want this message).
      process.stderr.write(
        `[mcp:${this.serverName}] WARNING: connected via deprecated SSE transport. ` +
        `Upgrade your MCP server to streamable-HTTP.\n`,
      );
    }

    this.client = activeClient;
    this.connected = true;
    // Successful connect — clear any pending-auth transport reference. The
    // transport is now owned by `client`; we must not double-manage it.
    this.pendingAuthTransport = undefined;
    // `transport` reference is owned by `client` from this point — closing
    // the client closes the transport. We intentionally don't retain a
    // separate handle to avoid the dual-source-of-truth bug.

    // Initial tools/list. We treat a listTools() failure as a connect
    // failure so the manager can mark the server `error` and skip it.
    //
    // Close the active client on timeout — we never finished the connect
    // sequence (no caller has the McpClient ref yet), so leaving the
    // transport open would orphan a socket/child process.
    const listed = await withTimeout(
      this.client.listTools(),
      timeoutMs,
      () => new Error(`MCP server "${this.serverName}" listTools timed out after ${timeoutMs}ms`),
      () => activeClient.close().catch(() => undefined),
    );
    const serverInfo = this.client.getServerVersion();
    return {
      tools: listed.tools,
      serverInfo: serverInfo
        ? { name: serverInfo.name, version: serverInfo.version }
        : undefined,
    };
  }

  /**
   * Re-fetch the server's tool list. Used by `notifications/tools/list_changed`
   * handling. Throws if not yet connected.
   *
   * Note: a timeout here does NOT close the underlying transport. Unlike the
   * connect-time call this runs against an already-handshaked client whose
   * lifecycle is owned by `McpManager`; the manager (or a subsequent
   * notification refresh) may legitimately retry against the same client.
   * The in-flight request remains dangling on the SDK side but is harmless.
   */
  async listTools(): Promise<McpTool[]> {
    if (!this.client) throw new Error(`McpClient(${this.serverName}): not connected`);
    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const listed = await withTimeout(
      this.client.listTools(),
      timeoutMs,
      () => new Error(`MCP server "${this.serverName}" listTools timed out after ${timeoutMs}ms`),
    );
    return listed.tools;
  }

  /**
   * Re-fetch the server's tool list and return the updated tools. Used by
   * `McpManager.refreshServer()` when the server sends
   * `notifications/tools/list_changed`. Semantically identical to
   * `listTools()` — the name signals intent at the call site.
   */
  async refreshTools(): Promise<McpTool[]> {
    return this.listTools();
  }

  /**
   * Invoke a tool by its server-side name (NOT the wire-encoded
   * `mcp__server__tool` form — the manager strips the prefix before
   * calling). Returns a normalized `ToolResult`.
   *
   * `signal` is honoured at the MCP layer via `options.signal`. Tool
   * execution itself is the server's responsibility; if the server doesn't
   * cancel on abort, the call may continue server-side, but the SDK will
   * stop awaiting it.
   */
  async callTool(
    toolName: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (!this.client) {
      return { content: `MCP server "${this.serverName}" is not connected`, isError: true };
    }
    if (signal.aborted) {
      return { content: 'Tool call aborted', isError: true };
    }
    const timeoutMs = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
    let result: CallToolResult;
    try {
      const raw = await this.client.callTool(
        {
          name: toolName,
          arguments: (input ?? {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        { signal, timeout: timeoutMs },
      );
      result = raw as CallToolResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `MCP tool "${this.serverName}.${toolName}" failed: ${msg}`,
        isError: true,
      };
    }

    return normalizeCallToolResult(result);
  }

  /**
   * Deliver the OAuth authorization code to the transport so it can exchange
   * it for tokens. Called by `McpManager.completeAuth()` → `/mcp auth
   * complete <server> <code>` after the user has visited the authorization
   * URL and been redirected back.
   *
   * Throws when no transport was retained (i.e. the server never entered
   * `oauth_pending` state, or `connect()` was never called).
   *
   * After `finishAuth` succeeds the caller should re-invoke `connect()` on
   * a fresh `McpClient` instance — the current instance's `connect()` threw
   * `UnauthorizedError` and left the SDK `Client` in an undefined state.
   * `McpManager.completeAuth()` handles the reconnect.
   */
  async finishAuth(authorizationCode: string): Promise<void> {
    if (!this.pendingAuthTransport) {
      throw new Error(
        `McpClient(${this.serverName}): no pending OAuth transport — ` +
        `server is not in oauth_pending state`,
      );
    }
    await this.pendingAuthTransport.finishAuth(authorizationCode);
    // Keep the reference alive until a successful connect() clears it —
    // the transport may be reused by the reconnect attempt.
  }

  /**
   * Best-effort tear-down. Calls `client.close()` which in turn closes the
   * transport. Safe to call multiple times. Never throws — failures are
   * logged at debug only because teardown errors are rarely actionable.
   */
  async disconnect(): Promise<void> {
    this.pendingAuthTransport = undefined;
    if (!this.client) return;
    const c = this.client;
    this.client = undefined;
    this.connected = false;
    try {
      await c.close();
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Convert MCP's `CallToolResult` shape to agent-afk's flat `ToolResult`.
 *
 * MCP returns a `content[]` array of typed blocks (text / image / resource);
 * agent-afk's dispatcher consumes a single string. We concatenate text
 * blocks and emit a placeholder note for non-text blocks. Image / resource
 * rich rendering is a separate PR.
 */
function normalizeCallToolResult(result: CallToolResult): ToolResult {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push(`[image block: mimeType=${block.mimeType}, ${block.data.length} bytes base64]`);
    } else if (block.type === 'resource') {
      // Both embedded and link variants. Surface the URI so the model can
      // at least cite it; payload bridging is a follow-up.
      const uri =
        'resource' in block && typeof block.resource === 'object'
          ? (block.resource as { uri?: string }).uri ?? '(unknown)'
          : '(unknown)';
      parts.push(`[resource block: ${uri}]`);
    } else {
      // Forward-compat: unknown block types serialize as JSON so debugging
      // is possible without code changes.
      parts.push(`[unknown block: ${JSON.stringify(block)}]`);
    }
  }
  const content = parts.join('\n');
  return {
    content: content.length === 0 ? '(empty tool result)' : content,
    ...(result.isError ? { isError: true } : {}),
  };
}

/**
 * Build the primary transport and, for streamable-HTTP, an optional fallback
 * factory for SSE. Returns a nullable `fallback` to make the call site
 * explicit about when a fallback is available.
 */
function buildTransportPair(
  serverName: string,
  config: McpServerConfig,
  oauthProvider: KeychainOAuthProvider | undefined,
): {
  primary: import('./transport.js').CreateTransportResult;
  fallback: (() => import('./transport.js').CreateTransportResult) | null;
} {
  const effectiveType = config.type ?? (config.command ? 'stdio' : 'streamable-http');
  const primary = createTransport(serverName, config, oauthProvider);
  // Only streamable-HTTP supports the SSE fallback probe.
  const fallback =
    effectiveType === 'streamable-http'
      ? () => createTransport(serverName, { ...config, type: 'sse' }, oauthProvider)
      : null;
  return { primary, fallback };
}

/**
 * True when `err` is a `StreamableHTTPError` with a 404 or 405 status code.
 * These indicate a server that only speaks SSE (legacy transport).
 */
function isHttpFallbackError(err: unknown): boolean {
  return (
    err instanceof StreamableHTTPError &&
    (err.code === 404 || err.code === 405)
  );
}

/** Extract the numeric HTTP status code from a `StreamableHTTPError`. */
function httpErrorCode(err: unknown): number | undefined {
  return err instanceof StreamableHTTPError ? err.code : undefined;
}

/**
 * Re-export `UnauthorizedError` for callers (e.g. `manager.ts`) that need
 * to distinguish OAuth-pending from hard connect failures.
 */
export { UnauthorizedError };

/**
 * Promise + timeout helper. Resolves with the original promise's value if
 * it settles in time; rejects with the supplied error factory's result on
 * timeout.
 *
 * The optional `onTimeout` cleanup callback is invoked when the timer fires.
 * Call sites that hold a transport / client reference pass a closer here so
 * the underlying socket, child process, or SSE stream is torn down promptly
 * instead of leaking until GC. The cleanup is fire-and-forget so a hung
 * close() can never block the rejection; close-errors are swallowed.
 *
 * Constraint: cleanup runs BEFORE the rejection so callers that immediately
 * retry on the same connection slot don't race a half-closed transport.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  makeError: () => Error,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout !== undefined) {
        try {
          const r = onTimeout();
          if (r && typeof (r as Promise<void>).then === 'function') {
            (r as Promise<void>).catch(() => undefined);
          }
        } catch {
          // Swallow — cleanup errors are never actionable on the timeout path.
        }
      }
      reject(makeError());
    }, ms);
  });
  return Promise.race([p, timeoutPromise]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
