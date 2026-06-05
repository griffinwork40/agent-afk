import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { join } from 'path';

interface ParsedCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Read the Claude Code OAuth access token from its native credential store.
 *
 * Sources, by platform:
 *   - macOS  → macOS Keychain entry `Claude Code-credentials`
 *   - linux  → `~/.claude/.credentials.json`
 *   - win32  → not supported; returns `undefined`
 *
 * Returns `undefined` when the entry is missing, malformed, or the access
 * token is past its `expiresAt`. This sync variant does not attempt a refresh;
 * use {@link refreshClaudeCodeOauthToken} for async refresh on 401.
 */
export function loadClaudeCodeOauthToken(): string | undefined {
  const blob = readCredentialsBlob();
  if (blob === undefined) return undefined;
  const parsed = parseCredentials(blob);
  if (parsed === undefined) return undefined;
  if (parsed.expiresAt !== undefined && parsed.expiresAt <= Date.now()) {
    process.stderr.write(
      'agent-afk: Claude Code OAuth token in keychain is expired. Run `claude login` to refresh.\n',
    );
    return undefined;
  }
  return parsed.accessToken;
}

/**
 * Attempt to refresh the OAuth token and return a fresh access token.
 *
 * Reads the credential blob, checks expiry (with a 5-minute margin), and
 * if expired or near-expiry, uses the stored `refreshToken` to obtain a
 * new access token from `platform.claude.com`. On success, writes the
 * updated credentials back to the same store Claude Code uses (keychain on
 * macOS, credentials file on Linux) — preserving all non-OAuth fields
 * (e.g. `mcpOAuth`).
 *
 * Returns `undefined` when refresh is impossible or fails; callers should
 * surface the original 401 error.
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

function readCredentialsBlob(): string | undefined {
  if (process.platform === 'darwin') {
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
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
      );
      return out.trim();
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'linux') {
    const path = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(path)) return undefined;
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return undefined;
    }
  }
  return undefined;
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
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
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
  const suffix = token.length >= 8 ? token.slice(-8) : token;
  return `token:${suffix}`;
}

function writeCredentialsBlob(blob: string): void {
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
  } else if (process.platform === 'linux') {
    const path = join(homedir(), '.claude', '.credentials.json');
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
  writeFileSync(credPath, blob, { encoding: 'utf-8', mode: 0o600 });
}
