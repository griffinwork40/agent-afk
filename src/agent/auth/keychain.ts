import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { atomicWriteFile } from '../../utils/atomic-write.js';
import { homedir, userInfo } from 'os';
import { join } from 'path';
import { h1ModelFetch } from '../providers/shared/h1-fetch.js';

interface ParsedCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Contract: bound the token-refresh network call. `refreshClaudeCodeOauthToken`
// is now awaited on the startup path (`preloadClaudeKeychainOAuth`), so an
// unbounded `fetch` would let a stalled / captive network hang boot up to
// undici's ~300s default. Cap it so a stalled refresh degrades to the prior
// fast-fail (`undefined`) path instead of blocking startup.
const OAUTH_REFRESH_TIMEOUT_MS = 10_000;

// Short-lived read cache for `loadClaudeCodeOauthToken`. The keychain now
// outranks the boot-time cache in credential-resolver, so every Anthropic
// credential read (including from forked subagents) calls `execFileSync
// security` on macOS. A 5-second window amortises that cost across the
// hot re-resolve path (tool calls within one session) while staying well
// inside any real-world token-rotation window (tokens expire in hours, not
// seconds). The cache is per-process and shared by every session in it,
// including forked subagents (they are in-process `AgentSession`s, see
// `subagent/fork-wiring.ts`); separate afk processes each read the live store.
const READ_CACHE_TTL_MS = 5_000;
let _readCacheValue: string | undefined;
let _readCacheExpiresAt = 0;

// Invariant: the macOS read is a SYNCHRONOUS subprocess, so it blocks the
// event loop of the whole process (every Telegram chat / web session in it)
// for as long as `security` runs. A locked keychain or an access prompt can
// hold it indefinitely.
//
// CONTRACT — two read modes, controlled by the `background` option on
// `loadClaudeCodeOauthToken`:
//
//   background: true  (per-turn catch-up, compaction sync, usage-limit pollers)
//     The subprocess is bounded by KEYCHAIN_READ_TIMEOUT_MS (3 s). A timeout
//     arms the backoff: further background reads skip the subprocess for
//     KEYCHAIN_TIMEOUT_BACKOFF_MS (30 s) and return `undefined` instead.
//     A successful background read clears the backoff.
//
//   background: false / absent  (startup, fork-time, /reauth, refresh/write-back)
//     No timeout is passed to execFileSync; the OS shows its unlock dialog if
//     the keychain is locked, and the user can interact with it. The backoff is
//     also ignored: foreground callers must always reach the live store. A
//     successful foreground read clears the backoff.
//
// Only a TIMEOUT arms the backoff: a missing entry must stay uncached so a
// `claude login` run while a daemon is live is picked up on the very next read.
//
// NOTE: the backoff state (_readBackoffUntil) is process-wide — it is shared
// by every session running in the same process (Telegram chats, daemon tasks,
// forked subagents). A single locked-keychain timeout blocks ALL background
// reads across every concurrent session for KEYCHAIN_TIMEOUT_BACKOFF_MS.
const KEYCHAIN_READ_TIMEOUT_MS = 3_000;
const KEYCHAIN_TIMEOUT_BACKOFF_MS = 30_000;
let _readBackoffUntil = 0;

/** @internal Exposed for tests that need hermetic control over the cache. */
export function _resetKeychainReadCache(): void {
  _readCacheValue = undefined;
  _readCacheExpiresAt = 0;
  _readBackoffUntil = 0;
}

/**
 * Read the Claude Code OAuth access token from its native credential store.
 *
 * Sources, by platform:
 *   - macOS  → macOS Keychain entry `Claude Code-credentials`
 *   - linux / win32 / other → `~/.claude/.credentials.json`
 *     (Claude Code stores credentials in this plaintext file on every
 *     platform except macOS; on Windows `homedir()` is `%USERPROFILE%`)
 *
 * Returns `undefined` when the entry is missing, malformed, or the access
 * token is past its `expiresAt`. This sync variant does not attempt a refresh;
 * use {@link refreshClaudeCodeOauthToken} for async refresh on 401.
 *
 * Contract: two option flags govern macOS subprocess behaviour (see the
 * KEYCHAIN_READ_TIMEOUT_MS block comment for the full two-mode spec):
 *
 *   `background: true` — the subprocess is bounded by KEYCHAIN_READ_TIMEOUT_MS
 *     and the process-wide backoff is honoured and armed on timeout. Use for
 *     per-turn catch-up, compaction sync, and usage-limit pollers.
 *
 *   `background: false` / absent — no timeout; the OS may show an unlock
 *     dialog; the backoff is ignored. Use for startup, fork-time, /reauth,
 *     and refresh/write-back paths where the user can interact.
 *
 *   `quiet: true` — suppresses the stderr "token is expired" warning.
 *     Always combine with `background: true` for per-turn callers, which
 *     would otherwise print that warning once per turn.
 */
export function loadClaudeCodeOauthToken(opts: { quiet?: boolean; background?: boolean } = {}): string | undefined {
  const now = Date.now();
  if (now < _readCacheExpiresAt) return _readCacheValue;

  // Reset cache before each live read so that failures never populate it.
  // Only a successful token read sets _readCacheExpiresAt; failure paths
  // leave it at 0 so the next call always re-reads the store (preventing
  // the stale "no credential" window that occurred when `claude login` ran
  // while a bot or daemon process was live).
  _readCacheValue = undefined;
  _readCacheExpiresAt = 0;

  const blob = readCredentialsBlob(opts.background === true);
  if (blob === undefined) return undefined;

  const parsed = parseCredentials(blob);
  if (parsed === undefined) return undefined;

  if (parsed.expiresAt !== undefined && parsed.expiresAt <= now) {
    if (opts.quiet !== true) {
      process.stderr.write(
        'agent-afk: Claude Code OAuth token in keychain is expired. Run `claude login` to refresh.\n',
      );
    }
    return undefined;
  }
  _readCacheValue = parsed.accessToken;
  _readCacheExpiresAt = now + READ_CACHE_TTL_MS;
  return _readCacheValue;
}

/**
 * Attempt to refresh the OAuth token and return a fresh access token.
 *
 * Reads the credential blob, checks expiry (with a 5-minute margin), and
 * if expired or near-expiry, uses the stored `refreshToken` to obtain a
 * new access token from `platform.claude.com`. On success, writes the
 * updated credentials back to the same store Claude Code uses (keychain on
 * macOS, credentials file everywhere else) — preserving all non-OAuth fields
 * (e.g. `mcpOAuth`).
 *
 * Returns `undefined` when refresh is impossible or fails, and never throws
 * (every failure path returns `undefined` or writes to stderr), so it is safe
 * to `await` on the startup critical path.
 *
 * Two callers, two contracts:
 *   - Per-request 401 retry (the original use): on `undefined`, surface the
 *     original 401 error.
 *   - Startup preload via {@link preloadClaudeKeychainOAuth}: refresh a
 *     near-expiry / expired keychain token and write it back BEFORE the
 *     synchronous credential read at boot. The network call is bounded by
 *     `OAUTH_REFRESH_TIMEOUT_MS` so it cannot hang startup.
 *
 * On a successful token exchange the fresh access token is returned even if
 * the write-back to the store fails (locked / read-only) — callers that need a
 * credential should use that return value rather than re-reading the store.
 */
export async function refreshClaudeCodeOauthToken(): Promise<string | undefined> {
  const blob = readCredentialsBlob();
  if (blob === undefined) return undefined;

  const parsed = parseCredentials(blob);
  if (parsed === undefined) return undefined;

  if (parsed.expiresAt !== undefined && parsed.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return parsed.accessToken;
  }

  if (!parsed.refreshToken) {
    process.stderr.write(
      'agent-afk: OAuth token expired and no refresh token available. Run `claude login` to refresh.\n',
    );
    return undefined;
  }

  const refreshed = await postTokenRefresh(parsed.refreshToken);
  if (!refreshed) {
    process.stderr.write(
      'agent-afk: OAuth token refresh failed. Run `claude login` to refresh.\n',
    );
    return undefined;
  }

  try {
    let fullBlob: Record<string, unknown> = {};
    try { fullBlob = JSON.parse(blob) as Record<string, unknown>; } catch { /* start fresh */ }

    const existing = (fullBlob['claudeAiOauth'] as Record<string, unknown>) ?? {};
    fullBlob['claudeAiOauth'] = {
      ...existing,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      ...(refreshed.refreshToken !== undefined ? { refreshToken: refreshed.refreshToken } : {}),
    };
    writeCredentialsBlob(JSON.stringify(fullBlob));
  } catch {
    process.stderr.write(
      'agent-afk: Refreshed OAuth token but failed to write back to credential store.\n',
    );
  }

  return refreshed.accessToken;
}

/**
 * Contract: `execFileSync` with a `timeout` kills the child and throws the
 * spawnSync error, whose `code` is `'ETIMEDOUT'`. Any other failure (entry
 * missing → non-zero exit) is NOT a timeout and must not arm the backoff.
 */
function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ETIMEDOUT';
}

function readCredentialsBlob(background = false): string | undefined {
  if (process.platform === 'darwin') {
    // Contract: background reads honour and arm the process-wide backoff and
    // pass a timeout to execFileSync. Foreground reads skip the backoff check
    // and pass no timeout so the OS unlock dialog can be shown.
    if (background && Date.now() < _readBackoffUntil) return undefined;
    try {
      // `-a` is required: macOS allows multiple keychain entries to share a
      // service name, and Claude Code's MCP-OAuth state shares this one. Without
      // `-a`, `security` returns the first match — often the MCP entry, which
      // has no `claudeAiOauth` field and silently fails the parse.
      const out = execFileSync(
        'security',
        [
          'find-generic-password',
          '-s', 'Claude Code-credentials',
          '-a', userInfo().username,
          '-w',
        ],
        background
          ? { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', timeout: KEYCHAIN_READ_TIMEOUT_MS }
          : { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
      );
      // A successful read (foreground or background) clears the backoff so
      // a subsequent background caller sees the live store again.
      _readBackoffUntil = 0;
      return out.trim();
    } catch (err) {
      if (background && isTimeoutError(err)) _readBackoffUntil = Date.now() + KEYCHAIN_TIMEOUT_BACKOFF_MS;
      return undefined;
    }
  }
  // Every non-macOS platform (linux, win32, ...) uses the plaintext file.
  // History: this branch was linux-only, so win32 silently returned
  // `undefined` and `afk login` asked Windows users for an API key even
  // after a successful `claude login`.
  const path = claudeCodeCredentialsPath();
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Path of Claude Code's plaintext credential file, used on every platform
 * except macOS (which uses the Keychain).
 *
 * @internal Exported for tests.
 */
export function claudeCodeCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

function parseCredentials(blob: string): ParsedCredentials | undefined {
  let json: unknown;
  try {
    json = JSON.parse(blob);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const oauth = (json as Record<string, unknown>)['claudeAiOauth'];
  if (typeof oauth !== 'object' || oauth === null) return undefined;
  const oauthObj = oauth as Record<string, unknown>;
  const accessToken = oauthObj['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined;
  const result: ParsedCredentials = { accessToken };
  const refreshToken = oauthObj['refreshToken'];
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    result.refreshToken = refreshToken;
  }
  const expiresAt = oauthObj['expiresAt'];
  if (typeof expiresAt === 'number') {
    result.expiresAt = expiresAt;
  }
  return result;
}

interface TokenRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

async function postTokenRefresh(refreshToken: string): Promise<TokenRefreshResponse | undefined> {
  try {
    // Invariant: use h1ModelFetch, not globalThis.fetch — the global may route
    // through an undici Agent with allowH2:true installed by jsdom, which on
    // Node 26 can trigger the spinning nghttp2 DATA-frame freeze (issue #3335).
    const res = await h1ModelFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      // Bounded so a stalled network cannot hang startup; the AbortSignal.timeout
      // rejection is caught below and surfaces as `undefined` (fast-fail).
      signal: AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, unknown>;
    const at = data['access_token'];
    const ei = data['expires_in'];
    if (typeof at !== 'string' || typeof ei !== 'number') return undefined;
    const rt = data['refresh_token'];
    return {
      accessToken: at,
      expiresAt: Date.now() + ei * 1000,
      ...(typeof rt === 'string' && rt.length > 0 ? { refreshToken: rt } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Extract a human-readable account identifier from an OAuth access token.
 *
 * The token is expected to be a JWT; the function decodes the payload and
 * tries the following claims in order: `email`, `sub`, `account_id`,
 * `preferred_username`. Falls back to `'token:<last-8-chars>'` when no
 * recognised claim is found or decoding fails.
 *
 * No new dependencies — uses `Buffer.from(segment, 'base64url')`.
 */
export function parseAccountIdentifier(token: string): string {
  if (!token || token.length < 3) return 'token:(unknown)';
  try {
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('not a JWT');
    const payload = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    const claims = JSON.parse(payload) as Record<string, unknown>;
    const id =
      (typeof claims['email'] === 'string' && claims['email']) ||
      (typeof claims['sub'] === 'string' && claims['sub']) ||
      (typeof claims['account_id'] === 'string' && claims['account_id']) ||
      (typeof claims['preferred_username'] === 'string' && claims['preferred_username']);
    if (id) return id;
  } catch { /* fall through */ }
  // TODO(#4370): pre-existing leak — the last 8 chars of the raw token are
  // included in trace events when the JWT decode path fails (non-JWT tokens,
  // opaque tokens). Not introduced by #4259. A future hardening pass should
  // replace this with a stable opaque fingerprint (e.g. first 8 chars of a
  // SHA-256 of the full token) so no token material appears in traces.
  const suffix = token.length >= 8 ? token.slice(-8) : token;
  return `token:${suffix}`;
}

function writeCredentialsBlob(blob: string): void {
  // Invalidate the read cache so that the very next loadClaudeCodeOauthToken
  // call reads the freshly-written store rather than returning a stale value
  // (guards the `claude login` race where writes occurred while a bot or
  // daemon process was live inside the 5-second cache window).
  _resetKeychainReadCache();
  if (process.platform === 'darwin') {
    execFileSync(
      'security',
      [
        'add-generic-password',
        '-U',
        '-s', 'Claude Code-credentials',
        '-a', userInfo().username,
        '-w', blob,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
  } else {
    const path = claudeCodeCredentialsPath();
    // S3 fix: write with mode 0o600 so only the owner can read credentials.
    // Constraint: POSIX file-mode semantics — mode must be set at creation time
    // because a subsequent chmod would TOCTOU-race. Pass mode in the options
    // object (not the legacy string overload) to guarantee the mode is applied.
    writeLinuxCredentials(path, blob);
  }
}

/**
 * Write the Linux credential file at `credPath` with mode 0o600.
 *
 * Exported for unit-testing the file-mode invariant (S3). Production callers
 * should use `writeCredentialsBlob` which resolves the canonical path.
 *
 * @internal
 */
export function writeLinuxCredentials(credPath: string, blob: string): void {
  atomicWriteFile(credPath, blob, { encoding: 'utf-8', mode: 0o600, mkdirp: false });
}
