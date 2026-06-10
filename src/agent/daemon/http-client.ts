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
  let port: number;
  try {
    const portFile = join(getDaemonStateDir('default'), 'port');
    if (!existsSync(portFile)) {
      return { synced: false, detail: 'daemon-not-detected (no port file)' };
    }
    const portStr = readFileSync(portFile, 'utf-8').trim();
    port = parseInt(portStr, 10);
    if (Number.isNaN(port)) {
      return { synced: false, detail: 'daemon-not-detected (invalid port file)' };
    }
  } catch {
    return { synced: false, detail: 'daemon-not-detected (unreadable port file)' };
  }
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
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
