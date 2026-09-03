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
import { expandEnvRecord, expandEnvRecordForLayer, expandEnvString } from './env.js';
import { scrubDangerousEnv, type McpServerLayer } from './env-containment.js';

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
 * The `layer` parameter drives defense-in-depth for project-local stdio
 * servers (issue #578):
 *   - Secret `${VAR}` expansions are blocked unless `allowSecretEnv` opts in.
 *   - Dangerous inherited env vars (`NODE_OPTIONS`, `LD_PRELOAD`, …) are
 *     scrubbed from the inherited base env before the child process is spawned.
 * User-global, plugin, and CLI servers are fully trusted and bypass both checks.
 *
 * Throws when the config is internally inconsistent (e.g. `type === 'stdio'`
 * with no `command`) — the loader validates these upfront, but the factory
 * guards defensively.
 */
export function createTransport(
  serverName: string,
  config: McpServerConfig,
  oauthProvider?: OAuthClientProvider,
  layer: McpServerLayer = 'user-global',
): CreateTransportResult {
  // Resolve effective type (loader already sets it, but guard in case the
  // factory is called outside the normal load path).
  const type = config.type ?? (config.command ? 'stdio' : 'streamable-http');

  if (type === 'stdio') {
    if (typeof config.command !== 'string' || config.command.length === 0) {
      throw new Error(`McpTransport(${serverName}): stdio requires \`command\``);
    }

    // ── Env expansion (layer-aware for project servers) ──────────────
    let expandedEnv: Record<string, string>;
    if (layer === 'project') {
      const { value: env, missing, blocked } = expandEnvRecordForLayer(
        config.env,
        { layer, serverName, allowSecretEnv: config.allowSecretEnv ?? [] },
      );
      if (missing.length > 0) {
        console.warn(
          `[mcp:${serverName}] missing env vars (passing as empty): ${missing.join(', ')}`,
        );
      }
      if (blocked.length > 0) {
        // Individual warnings already emitted by expandEnvRecordForLayer.
        // Emit a summary so the connect log also shows the impact.
        console.warn(
          `[mcp:${serverName}] ${blocked.length} secret expansion(s) blocked for project-local server`,
        );
      }
      expandedEnv = env;
    } else {
      const { value: env, missing } = expandEnvRecord(config.env);
      if (missing.length > 0) {
        // Forward as a console warn — manager logs the per-server status
        // separately; this gives per-variable visibility.
        console.warn(
          `[mcp:${serverName}] missing env vars (passing as empty): ${missing.join(', ')}`,
        );
      }
      expandedEnv = env;
    }

    // ── Build the base inherited env ──────────────────────────────────
    const base = inheritedDefaultEnv();

    // Scrub dangerous inherited vars for project-local servers (issue #578).
    if (layer === 'project') {
      const scrubbed = scrubDangerousEnv(base);
      if (scrubbed.length > 0) {
        console.warn(
          `[mcp:${serverName}] scrubbed dangerous inherited env vars for project-local server: ${scrubbed.join(', ')}`,
        );
      }
    }

    const params: StdioServerParameters = {
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      env: { ...base, ...expandedEnv },
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

