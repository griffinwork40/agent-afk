/**
 * MCP transport factory.
 *
 * Centralises the decision of which SDK transport class to instantiate based
 * on the `McpServerConfig.type` field (or the inferred value when `type` is
 * absent). The factory is extracted from `client.ts` so that:
 *
 *   1. `client.ts` stays focused on lifecycle / protocol concerns.
 *   2. `transport.test.ts` can verify transport selection without exercising
 *      the full `Client.connect()` path.
 *
 * Transport selection rules (highest-priority wins):
 *   - `type === 'stdio'`            → `StdioClientTransport`
 *   - `type === 'sse'`              → `SSEClientTransport` (+ deprecation warn)
 *   - `type === 'streamable-http'`  → `StreamableHTTPClientTransport`
 *   - `type` absent, `command` set → `StdioClientTransport` (inferred by loader)
 *   - `type` absent, `url` set     → `StreamableHTTPClientTransport` (inferred)
 *
 * SSE fallback probe: when `type === 'streamable-http'` and the server
 * responds with HTTP 404 or 405, `connectWithFallback()` transparently
 * retries with `SSEClientTransport`. This matches the upstream SDK guidance
 * for clients that must support both legacy and modern servers.
 *
 * Headers expansion: `${VAR}` placeholders in `config.headers` are resolved
 * from `process.env` at call time (never at config-load time, to keep secret
 * values out of the in-memory config). Mirrors the same policy as `env.ts`
 * for the stdio `env` field.
 *
 * @module agent/mcp/transport
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import type { McpServerConfig } from './types.js';
import { expandEnvRecord, expandEnvString } from './env.js';

/**
 * True for hostnames whose traffic never leaves the local machine — the
 * canonical loopback aliases. Plaintext HTTP to these hosts cannot leak
 * credentials across a network, so the scheme guard in `createTransport()`
 * exempts them.
 *
 * Bracketed IPv6 (`[::1]`) is the form `new URL(...).hostname` returns for
 * IPv6 literals; the bare `::1` form is included for defence-in-depth in
 * case a future change parses URLs differently.
 */
function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  );
}

/** The set of env vars a stdio transport inherits from the parent process. */
function inheritedDefaultEnv(): Record<string, string> {
  const keys = [
    'PATH', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'TERM',
    'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'NODE_PATH',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Expand `${VAR}` placeholders in the `headers` map against `process.env`
 * (or a caller-supplied source for tests).
 *
 * Headers that reference at least one missing (unset) variable are omitted
 * entirely from the output — a partial header value like `"Bearer "` is
 * worse than no header. The caller still receives the `missing` list for
 * logging so the user sees the missing variable name rather than a cryptic
 * 401 from the server.
 */
export function expandHeaders(
  headers: Record<string, string> | undefined,
  source: NodeJS.ProcessEnv = process.env,
): { headers: Record<string, string>; missing: string[] } {
  if (headers === undefined) return { headers: {}, missing: [] };
  const filtered: Record<string, string> = {};
  const missingSet = new Set<string>();
  for (const [key, raw] of Object.entries(headers)) {
    const { value, missing } = expandEnvString(raw, source);
    if (missing.length > 0) {
      // At least one variable was unset — omit the header entirely.
      for (const m of missing) missingSet.add(m);
    } else {
      filtered[key] = value;
    }
  }
  return { headers: filtered, missing: [...missingSet] };
}

/**
 * Result of `createTransport()`. Carries the transport AND a flag that
 * records whether SSE was actually chosen (so `client.ts` can emit the
 * deprecation warning after the fact and update status).
 */
export interface CreateTransportResult {
  transport: Transport;
  /** True when `SSEClientTransport` was chosen (either explicit or fallback). */
  isSSE: boolean;
}

/**
 * Instantiate the appropriate SDK transport from a validated
 * `McpServerConfig`. Performs `${VAR}` expansion on `headers` at this point
 * so that secret values never sit in the in-memory config.
 *
 * For streamable-HTTP + SSE variants an optional `oauthProvider` is wired
 * into the transport options so the SDK can handle token refresh internally.
 *
 * Throws when the config is internally inconsistent (e.g. `type === 'stdio'`
 * with no `command`) — the loader validates these upfront, but the factory
 * guards defensively.
 */
export function createTransport(
  serverName: string,
  config: McpServerConfig,
  oauthProvider?: OAuthClientProvider,
): CreateTransportResult {
  // Resolve effective type (loader already sets it, but guard in case the
  // factory is called outside the normal load path).
  const type = config.type ?? (config.command ? 'stdio' : 'streamable-http');

  if (type === 'stdio') {
    if (typeof config.command !== 'string' || config.command.length === 0) {
      throw new Error(`McpTransport(${serverName}): stdio requires \`command\``);
    }

    const { value: env, missing } = expandEnvRecord(config.env);
    if (missing.length > 0) {
      // Forward as a console warn — manager logs the per-server status
      // separately; this gives per-variable visibility.
      console.warn(
        `[mcp:${serverName}] missing env vars (passing as empty): ${missing.join(', ')}`,
      );
    }

    const params: StdioServerParameters = {
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      env: { ...inheritedDefaultEnv(), ...env },
    };
    return { transport: new StdioClientTransport(params), isSSE: false };
  }

  if (type === 'streamable-http' || type === 'sse') {
    if (typeof config.url !== 'string' || config.url.length === 0) {
      throw new Error(`McpTransport(${serverName}): ${type} requires \`url\``);
    }

    const url = new URL(config.url);

    // Plaintext guard: refuse non-https URLs that aren't loopback. Bearer
    // tokens, OAuth Authorization headers, and tool I/O would otherwise transit
    // the network in cleartext. Loopback addresses are exempt so local-dev
    // workflows ("npm start" on http://localhost:3000) still work.
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
      throw new Error(
        `McpTransport(${serverName}): refusing ${type} URL ${url.protocol}//${url.hostname} — ` +
        `credentials and tool I/O would transit in plaintext. ` +
        `Use https:, or point the URL at localhost / 127.0.0.1.`,
      );
    }

    const { headers: expandedHeaders, missing } = expandHeaders(config.headers);
    if (missing.length > 0) {
      console.warn(
        `[mcp:${serverName}] missing header vars (passing as omitted): ${missing.join(', ')}`,
      );
    }

    if (type === 'sse') {
      // Deprecation warning: SSE transport is deprecated upstream.
      // Constraint: emit before constructing so the caller sees it even on
      // synchronous throw paths.
      process.stderr.write(
        `[mcp:${serverName}] WARNING: SSE transport is deprecated. Upgrade your MCP server to use streamable-HTTP.\n`,
      );
      const transport = new SSEClientTransport(url, {
        ...(Object.keys(expandedHeaders).length > 0
          ? { requestInit: { headers: expandedHeaders } }
          : {}),
        ...(oauthProvider ? { authProvider: oauthProvider } : {}),
      });
      return { transport, isSSE: true };
    }

    // streamable-http (default for remote servers)
    const transport = new StreamableHTTPClientTransport(url, {
      ...(Object.keys(expandedHeaders).length > 0
        ? { requestInit: { headers: expandedHeaders } }
        : {}),
      ...(oauthProvider ? { authProvider: oauthProvider } : {}),
    });
    return { transport, isSSE: false };
  }

  // Defensive: exhaustiveness guard — TypeScript should catch this at
  // compile time but guards against future type additions.
  throw new Error(
    `McpTransport(${serverName}): unknown transport type "${String(type)}"`,
  );
}

/**
 * Attempt streamable-HTTP first; fall back to SSE when the server replies
 * with 404 or 405 (indicating a legacy SSE-only server). Emits the
 * deprecation warning on fallback.
 *
 * Returns the transport that actually succeeded at the TCP/HTTP level (i.e.
 * prior to the MCP handshake). The caller is responsible for calling
 * `Client.connect()`.
 *
 * Note: "succeeded" here means the transport object was constructed and is
 * ready for `Client.connect()`; actual connection is deferred to the caller
 * via the standard SDK `client.connect(transport)` call. The fallback probe
 * logic is handled inside `client.ts` by catching `StreamableHTTPError` with
 * code 404/405 from the first connect attempt.
 */
export function createTransportWithFallbackHint(
  serverName: string,
  config: McpServerConfig,
  oauthProvider?: OAuthClientProvider,
): { primary: CreateTransportResult; fallback: () => CreateTransportResult } {
  const primary = createTransport(serverName, config, oauthProvider);
  const fallback = () => {
    // Build the SSE config by overriding type.
    const sseConfig: McpServerConfig = { ...config, type: 'sse' };
    return createTransport(serverName, sseConfig, oauthProvider);
  };
  return { primary, fallback };
}
