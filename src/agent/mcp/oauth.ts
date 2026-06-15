/**
 * OAuth provider for MCP remote servers.
 *
 * Implements the SDK's `OAuthClientProvider` interface, backed by the
 * existing `Claude Code-credentials` keychain entry (macOS) or
 * `~/.claude/.credentials.json` (Linux). MCP OAuth state is stored under
 * the `mcpOAuth` top-level key, scoped per-server by the server name.
 *
 * Per-server key layout inside the credentials blob:
 *
 *   {
 *     "claudeAiOauth": { ... },     ← managed by Claude Code itself
 *     "mcpOAuth": {
 *       "<serverName>": {
 *         "tokens":           OAuthTokens | undefined,
 *         "clientInfo":       OAuthClientInformationMixed | undefined,
 *         "codeVerifier":     string | undefined,
 *         "discoveryState":   OAuthDiscoveryState | undefined,
 *       }
 *     }
 *   }
 *
 * OAuth redirect URL surfacing:
 *   - When running with Telegram configured, the authorization URL is pushed
 *     via `pushIfConfigured()`.
 *   - When Telegram is unconfigured, the URL is written to stderr AND the
 *     path `~/.afk/state/mcp/server-status.json` is updated with an
 *     `oauth_pending` entry so the `/mcp` command can surface it.
 *
 * Design note: `redirectToAuthorization` is the only method that has side
 * effects outside this module. Everything else is pure keychain I/O.
 *
 * @module agent/mcp/oauth
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
  OAuthClientMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { getOauthPendingPath } from '../../paths.js';

/** TTL for oauth_pending entries. Flows older than this are treated as absent. */
const TTL_MS = 10 * 60 * 1_000; // 10 minutes

// ---------------------------------------------------------------------------
// Interfaces for the keychain storage shape
// ---------------------------------------------------------------------------

/** Per-server OAuth slot stored inside the credentials blob. */
interface McpOAuthSlot {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  /** OAuth `state` parameter — see `KeychainOAuthProvider.state()`. */
  state?: string;
}

/** Shape of the `mcpOAuth` top-level key in the credentials JSON. */
type McpOAuthStore = Record<string, McpOAuthSlot>;

// ---------------------------------------------------------------------------
// Keychain I/O helpers (platform-aware, mirroring keychain.ts)
// ---------------------------------------------------------------------------

/**
 * An injectable storage backend. Default implementation reads/writes the
 * native credential store. Swap in tests by providing a custom
 * `KeychainBackend`.
 */
export interface KeychainBackend {
  read(): string | undefined;
  write(blob: string): void;
}

/** Default backend: macOS Keychain / Linux credentials file. */
function defaultBackend(): KeychainBackend {
  const isDarwin = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';

  return {
    read(): string | undefined {
      if (isDarwin) {
        try {
          return execFileSync(
            'security',
            ['find-generic-password', '-s', 'Claude Code-credentials', '-a', userInfo().username, '-w'],
            { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
          ).trim() || undefined;
        } catch {
          return undefined;
        }
      }
      if (isLinux) {
        const path = join(homedir(), '.claude', '.credentials.json');
        if (!existsSync(path)) return undefined;
        try {
          return readFileSync(path, 'utf-8');
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    write(blob: string): void {
      if (isDarwin) {
        // SECURITY: the credentials blob is passed as an argv element to
        // `security add-generic-password -w <blob>`. On macOS Mojave (10.14)
        // and later, `ps` only exposes another process's argv to root or to
        // the same UID — and a same-UID attacker already has full keychain
        // access via the user's session. This matches the existing pattern
        // in `src/agent/auth/keychain.ts` (used for Claude Code's own OAuth
        // tokens), so we deliberately preserve it here for compatibility.
        // A stronger fix (native Keychain Services via node-keytar, or a
        // 0o600 temp file shim) is tracked as a follow-up.
        execFileSync(
          'security',
          ['add-generic-password', '-U', '-s', 'Claude Code-credentials', '-a', userInfo().username, '-w', blob],
          { stdio: ['ignore', 'ignore', 'ignore'] },
        );
      } else if (isLinux) {
        const path = join(homedir(), '.claude', '.credentials.json');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, blob, { encoding: 'utf-8', mode: 0o600 });
      }
      // Other platforms: no-op (unsupported).
    },
  };
}

// ---------------------------------------------------------------------------
// OAuth state file (for headless redirect URL surfacing)
// ---------------------------------------------------------------------------

/**
 * Shape of one entry in the oauth_pending state file. Written by
 * `writeOauthPending()` and read by `readOauthPending()` /
 * the `/mcp auth` slash command.
 */
export interface OauthPendingEntry {
  status: 'oauth_pending';
  authorizationUrl: string;
  /** ms-since-epoch when the entry was written. */
  timestamp: number;
}

/**
 * Read the OAuth state file. Returns `{}` when missing or unreadable —
 * the file is purely a status surface, so transient I/O errors must not
 * crash the slash command path.
 *
 * Entries whose shape doesn't match `OauthPendingEntry` are silently
 * dropped (forward-compat: a future SDK rev may add fields, and we don't
 * want to crash on a partially-valid entry).
 */
export function readOauthPending(): Record<string, OauthPendingEntry> {
  const path = getOauthPendingPath();
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const out: Record<string, OauthPendingEntry> = {};
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (
      r['status'] === 'oauth_pending' &&
      typeof r['authorizationUrl'] === 'string' &&
      typeof r['timestamp'] === 'number' &&
      Date.now() - r['timestamp'] <= TTL_MS
    ) {
      out[name] = {
        status: 'oauth_pending',
        authorizationUrl: r['authorizationUrl'],
        timestamp: r['timestamp'],
      };
    }
  }
  return out;
}

/**
 * Remove a server's oauth_pending entry from the state file. Best-effort —
 * a missing file or absent entry is a no-op. Called when an OAuth flow
 * completes successfully so the slash command stops reporting it as pending.
 */
export function clearOauthPending(serverName: string): void {
  const path = getOauthPendingPath();
  if (!existsSync(path)) return;
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!(serverName in existing)) return;
  delete existing[serverName];
  writeFileSync(path, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/** Write (or update) an oauth_pending entry in the state file. */
function writeOauthPending(serverName: string, authUrl: string): void {
  const path = getOauthPendingPath();
  mkdirSync(dirname(path), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Start fresh on parse error.
    }
  }
  // Strip PKCE params (state, code_challenge, etc.) before persisting — only
  // the base URL is needed for display by /mcp auth. The full URL (with PKCE
  // params) is shown to the user separately via Telegram / stderr.
  const parsedUrl = new URL(authUrl);
  const baseUrl = parsedUrl.origin + parsedUrl.pathname;
  existing[serverName] = {
    status: 'oauth_pending',
    authorizationUrl: baseUrl,
    timestamp: Date.now(),
  };
  writeFileSync(path, JSON.stringify(existing, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// KeychainOAuthProvider
// ---------------------------------------------------------------------------

/**
 * `OAuthClientProvider` backed by the agent-afk credential store.
 *
 * One instance per MCP server. Stores all OAuth state under
 * `mcpOAuth.<serverName>` in the same credential blob that Claude Code uses
 * for its own OAuth tokens — keeping all auth material in one place.
 */
export class KeychainOAuthProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly backend: KeychainBackend;

  /**
   * @param serverName   Key in the `mcpServers` map (used as storage key).
   * @param backend      Injectable keychain backend (default: native store).
   */
  constructor(serverName: string, backend: KeychainBackend = defaultBackend()) {
    this.serverName = serverName;
    this.backend = backend;
  }

  // ---------------------------------------------------------------------------
  // OAuthClientProvider — identity
  // ---------------------------------------------------------------------------

  /**
   * Redirect URL used during the auth flow. For headless (daemon / Telegram)
   * contexts there is no browser to redirect; we use a localhost sentinel
   * that the user visits manually. The SDK's `redirectToAuthorization` call
   * fires before any redirect happens — we surface the URL there instead.
   *
   * Note: some servers perform Dynamic Client Registration and embed this
   * URI in the registration request. `urn:ietf:wg:oauth:2.0:oob` is the
   * conventional "out-of-band" sentinel for non-web clients.
   */
  get redirectUrl(): string {
    return 'http://localhost:3000/oauth/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: 'agent-afk',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  // ---------------------------------------------------------------------------
  // OAuthClientProvider — storage (keychain-backed)
  // ---------------------------------------------------------------------------

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._readSlot().clientInfo;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._updateSlot((slot) => ({ ...slot, clientInfo: info }));
  }

  tokens(): OAuthTokens | undefined {
    return this._readSlot().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._updateSlot((slot) => ({ ...slot, tokens }));
    // Tokens-received signal: the OAuth dance has completed. Clear the
    // `oauth_pending` state file entry so `/mcp auth` stops reporting this
    // server as pending. Best-effort — failures here must not interrupt
    // the auth flow.
    try {
      clearOauthPending(this.serverName);
    } catch {
      // Swallow — see comment above.
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._updateSlot((slot) => ({ ...slot, codeVerifier }));
  }

  codeVerifier(): string {
    const v = this._readSlot().codeVerifier;
    if (!v) throw new Error(`[mcp:${this.serverName}] no PKCE code verifier stored`);
    return v;
  }

  /**
   * OAuth `state` parameter.
   *
   * `state` is only RECOMMENDED by OAuth 2.1 (PKCE already defends the code
   * exchange against CSRF), so the SDK omits it from the authorization URL
   * unless the provider supplies one. Some authorization servers nonetheless
   * REQUIRE `state` and reject the authorize request with `invalid_request`
   * when it is absent — Mintlify's admin MCP (`https://mcp.mintlify.com`) is
   * one such server.
   *
   * We generate a random value once per server and persist it so repeated
   * `state()` calls within a flow return the same value. The SDK does not
   * validate the echoed value on the token exchange, so this exists purely to
   * satisfy servers that mandate the parameter's presence.
   */
  state(): string {
    const existing = this._readSlot().state;
    if (existing) return existing;
    const generated = randomUUID();
    this._updateSlot((slot) => ({ ...slot, state: generated }));
    return generated;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this._updateSlot((slot) => ({ ...slot, discoveryState: state }));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this._readSlot().discoveryState;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this._updateSlot((slot) => {
      if (scope === 'all') return {};
      const updated = { ...slot };
      if (scope === 'client') delete updated.clientInfo;
      if (scope === 'tokens') delete updated.tokens;
      if (scope === 'verifier') {
        // `state` and the PKCE verifier are both per-authorization-attempt
        // artifacts — drop them together so a re-auth starts a clean flow.
        delete updated.codeVerifier;
        delete updated.state;
      }
      if (scope === 'discovery') delete updated.discoveryState;
      return updated;
    });
  }

  // ---------------------------------------------------------------------------
  // OAuthClientProvider — redirect (side-effecting)
  // ---------------------------------------------------------------------------

  /**
   * Called by the SDK when the server requires authorization. Routes the URL
   * via Telegram push if configured; otherwise writes to stderr and records
   * `oauth_pending` state in `~/.afk/state/mcp/server-status.json`.
   *
   * Constraint: the URL must be surfaced before this method returns so the
   * user can act on it. Telegram push is fire-and-forget async; we await it
   * here via a synchronous code path workaround — the SDK declares the return
   * type as `void | Promise<void>` so we can return a Promise.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const urlString = authorizationUrl.toString();
    const message =
      `🔐 MCP server "${this.serverName}" requires authorization.\n\n` +
      `Open this URL to authorize:\n${urlString}`;

    // Write oauth_pending state first — constraint: persistence before UI.
    writeOauthPending(this.serverName, urlString);

    // Attempt Telegram push (lazy import to avoid pulling telegram deps into
    // contexts that don't use it).
    let pushed = false;
    try {
      const { pushIfConfigured } = await import('../../telegram/push.js');
      const result = await pushIfConfigured(message);
      pushed = result !== null;
    } catch {
      // pushIfConfigured import may fail in minimal test environments — fall
      // through to stderr.
    }

    if (!pushed) {
      process.stderr.write(
        `[mcp:${this.serverName}] OAuth authorization required.\n` +
        `Open this URL to authorize:\n${urlString}\n` +
        `Status written to: ${getOauthPendingPath()}\n`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private keychain helpers
  // ---------------------------------------------------------------------------

  /** Read the per-server slot, returning an empty object if absent. */
  private _readSlot(): McpOAuthSlot {
    const blob = this.backend.read();
    if (!blob) return {};
    try {
      const full = JSON.parse(blob) as Record<string, unknown>;
      const store = full['mcpOAuth'] as McpOAuthStore | undefined;
      return store?.[this.serverName] ?? {};
    } catch {
      return {};
    }
  }

  /** Apply a mutation function to the per-server slot and write back. */
  private _updateSlot(mutate: (current: McpOAuthSlot) => McpOAuthSlot): void {
    const blob = this.backend.read();
    let full: Record<string, unknown> = {};
    if (blob) {
      try {
        full = JSON.parse(blob) as Record<string, unknown>;
      } catch {
        // Start fresh on corrupt blob.
      }
    }
    const store = (full['mcpOAuth'] as McpOAuthStore | undefined) ?? {};
    const current = store[this.serverName] ?? {};
    store[this.serverName] = mutate(current);
    full['mcpOAuth'] = store;
    this.backend.write(JSON.stringify(full));
  }
}
