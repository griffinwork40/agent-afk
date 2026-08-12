/**
 * SuperGrok / SuperGrok Heavy / X Premium+ OAuth token store for the xAI provider.
 *
 * Patterned after MCP OAuth secure file I/O (`src/agent/mcp/oauth.ts`): mode
 * 0600 writes, best-effort reads that never throw for a missing file, and
 * never logs token material.
 *
 * Invariant: xAI returns a NEW refresh_token on every successful refresh.
 * Callers that refresh MUST pass both the new access_token and the new
 * refresh_token into {@link writeXaiTokens} so the next refresh does not
 * fail with a stale single-use refresh token.
 *
 * @module agent/providers/xai/auth-store
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getAfkStateDir } from '../../../paths.js';

/**
 * OAuth token path under state: `$AFK_STATE_DIR/xai/auth.json`.
 * Uses {@link getAfkStateDir} rather than hand-joining `$AFK_HOME`.
 */
export function getXaiAuthPath(): string {
  return join(getAfkStateDir(), 'xai', 'auth.json');
}

/** Durable token bundle written under `~/.afk/state/xai/auth.json`. */
export interface XaiTokenBundle {
  access_token: string;
  refresh_token: string;
  /** Epoch seconds when access_token expires. */
  expires_at: number;
  token_type?: string;
  scope?: string;
}

/** Injectable fs surface so unit tests never touch disk. */
export interface XaiAuthStoreDeps {
  authPath?: () => string;
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, data: string, mode: number) => void;
  mkdir?: (dir: string) => void;
  unlink?: (path: string) => void;
  exists?: (path: string) => boolean;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function defaultWriteFile(path: string, data: string, mode: number): void {
  writeFileSync(path, data, { encoding: 'utf-8', mode });
}

function defaultMkdir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function defaultUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing file is a no-op for logout.
  }
}

/**
 * Parse a token bundle from JSON. Returns null on any malformed shape so
 * callers fall through to no-usable-auth rather than throwing at session start.
 */
export function parseXaiTokenBundle(raw: string): XaiTokenBundle | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const access = o['access_token'];
  const refresh = o['refresh_token'];
  const expires = o['expires_at'];
  if (typeof access !== 'string' || access.length === 0) return null;
  if (typeof refresh !== 'string' || refresh.length === 0) return null;
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return null;
  const bundle: XaiTokenBundle = {
    access_token: access,
    refresh_token: refresh,
    expires_at: expires,
  };
  if (typeof o['token_type'] === 'string') bundle.token_type = o['token_type'];
  if (typeof o['scope'] === 'string') bundle.scope = o['scope'];
  return bundle;
}

/** Read the on-disk OAuth bundle, or null when absent/unreadable/invalid. */
export function readXaiTokens(deps: XaiAuthStoreDeps = {}): XaiTokenBundle | null {
  const path = (deps.authPath ?? getXaiAuthPath)();
  const readFile = deps.readFile ?? defaultReadFile;
  const raw = readFile(path);
  if (raw === null) return null;
  return parseXaiTokenBundle(raw);
}

/**
 * Persist a token bundle (mode 0600).
 *
 * Contract: must include the latest refresh_token after every refresh —
 * xAI rotates refresh tokens on each successful refresh response.
 */
export function writeXaiTokens(bundle: XaiTokenBundle, deps: XaiAuthStoreDeps = {}): void {
  const path = (deps.authPath ?? getXaiAuthPath)();
  const mkdir = deps.mkdir ?? defaultMkdir;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  mkdir(dirname(path));
  const payload: Record<string, unknown> = {
    access_token: bundle.access_token,
    refresh_token: bundle.refresh_token,
    expires_at: bundle.expires_at,
  };
  if (bundle.token_type !== undefined) payload['token_type'] = bundle.token_type;
  if (bundle.scope !== undefined) payload['scope'] = bundle.scope;
  writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
}

/** Delete the token file (logout). No-op when the file is already gone. */
export function clearXaiTokens(deps: XaiAuthStoreDeps = {}): void {
  const path = (deps.authPath ?? getXaiAuthPath)();
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const unlink = deps.unlink ?? defaultUnlink;
  if (exists(path)) unlink(path);
}

/** Last 4 chars of a token — safe for diagnostics. */
export function last4OfToken(token: string): string {
  return token.length <= 4 ? token : token.slice(-4);
}
