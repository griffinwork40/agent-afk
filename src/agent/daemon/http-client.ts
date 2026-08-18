/**
 * HTTP client for live-syncing schedule changes to a running daemon instance.
 *
 * Shared between the tool handlers (create_schedule / cancel_schedule) and the
 * CLI subcommands (afk schedule add/remove/enable/disable) so both surfaces
 * surface the same outcome rather than the CLI silently swallowing errors.
 *
 * @module agent/daemon/http-client
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDaemonStateDir } from '../../paths.js';

/** Outcome of a live-sync attempt against a running daemon. */
export interface DaemonSyncResult {
  /** True when the running daemon's state matches the store after the call. */
  synced: boolean;
  /** Machine-readable detail, e.g. 'synced', 'already-registered', 'daemon-not-detected (no port file)'. */
  detail: string;
}

/** Human-actionable note attached to results when live-sync did not land. */
export const SYNC_FAILED_NOTE =
  'Change saved to schedules.json, but a running daemon (if any) did not pick it up — ' +
  'it will apply on the next daemon (re)start.';

/**
 * Attempt to notify the running daemon of a task change and report the
 * outcome. Never throws — the file store is the source of truth and a
 * failed sync must not fail the write — but the result is surfaced to the
 * caller so a daemon that will not see the change until restart is visible
 * instead of silently assumed in sync.
 *
 * End-state semantics: a 409 on POST (already registered) and a 404 on
 * DELETE (not registered) both mean the daemon already matches the desired
 * outcome, so they count as synced.
 */
export async function trySyncToDaemon(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<DaemonSyncResult> {
  let host: string;
  let port: number;
  try {
    const portFile = join(getDaemonStateDir('default'), 'port');
    if (!existsSync(portFile)) {
      return { synced: false, detail: 'daemon-not-detected (no port file)' };
    }
    const raw = readFileSync(portFile, 'utf-8').trim();
    // New format: "host:port" (e.g. "127.0.0.1:7777" or "::1:7777").
    // Backward compat: bare port number from pre-fallback daemon versions.
    const parsed = parsePortFile(raw);
    if (!parsed) {
      return { synced: false, detail: 'daemon-not-detected (invalid port file)' };
    }
    ({ host, port } = parsed);
  } catch {
    return { synced: false, detail: 'daemon-not-detected (unreadable port file)' };
  }
  try {
    // Invariant: IPv6 addresses must be bracketed in URLs (RFC 2732).
    const hostInUrl = host.includes(':') ? `[${host}]` : host;
    const res = await fetch(`http://${hostInUrl}:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return { synced: true, detail: 'synced' };
    if (method === 'POST' && res.status === 409) {
      return { synced: true, detail: 'already-registered' };
    }
    if (method === 'DELETE' && res.status === 404) {
      return { synced: true, detail: 'not-registered' };
    }
    return { synced: false, detail: `daemon-rejected (HTTP ${res.status})` };
  } catch {
    // STALE-FILE NOTE: port file may be stale after SIGKILL; fetch fails here.
    return { synced: false, detail: 'daemon-unreachable (stale port file or network error)' };
  }
}

/**
 * Parse the port discovery file. Supports two formats:
 *  - New: "host:port" (e.g. "127.0.0.1:7777", "::1:7777")
 *  - Legacy: bare port number (e.g. "7777") — defaults host to "localhost"
 *
 * Returns `null` on parse failure.
 *
 * @internal — exported for testing.
 */
export function parsePortFile(raw: string): { host: string; port: number } | null {
  // Legacy: bare integer
  const barePort = parseInt(raw, 10);
  if (String(barePort) === raw && !Number.isNaN(barePort)) {
    if (barePort < 1 || barePort > 65535) return null;
    return { host: 'localhost', port: barePort };
  }
  // New: last colon separates host from port (handles IPv6 like "::1:7777")
  const lastColon = raw.lastIndexOf(':');
  if (lastColon < 1) return null;
  const host = raw.slice(0, lastColon);
  const portStr = raw.slice(lastColon + 1);
  // Require the port segment to be a non-empty string of digits only.
  if (!/^\d+$/.test(portStr)) return null;
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port)) return null;
  if (port < 1 || port > 65535) return null;
  // Reject degenerate hosts that are only colons (e.g. "::" from splitting "::1").
  // A valid host must contain at least one non-colon character.
  if (/^:+$/.test(host)) return null;
  // Strip surrounding brackets from bracketed IPv6 literals (e.g. "[::1]" → "::1").
  // trySyncToDaemon re-adds brackets when building the URL, so double-bracketing
  // ([[::1]]) would cause a TypeError — strip here to keep the stored host clean.
  const cleanHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return { host: cleanHost, port };
}
