/**
 * Session source for the `afk web` UI.
 *
 * Enumerates agent sessions the web UI can show. Sessions created inside
 * THIS `afk web` process ("owned") get full duplex access — the UI can
 * render approve/answer controls for them because `elicitationRouter` is a
 * single-slot, process-wide singleton and can only resolve elicitations for
 * sessions this process itself owns. Every other session discovered on disk
 * ("foreign") is attach-only: the UI can tail its ledger and render it
 * read-only, but any approve button for it could never resolve. Getting the
 * owned/foreign discriminator wrong means rendering controls that silently
 * hang forever — so `owned` membership is authoritative and is never
 * inferred from disk state.
 *
 * @module web-server/session-source
 */

import * as fsp from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { getSessionLedgerPath, getSessionsDir, isSafeLedgerSessionId } from '../paths.js';
import { readLedger } from '../agent/session-ledger.js';
import { readLivePresenceFiles } from '../agent/awareness/presence.js';

/** One agent session as the web UI's session list can render it. */
export interface WebSessionSummary {
  id: string;
  /** 'live' iff `id` was a member of the `owned` set passed to {@link listWebSessions}. */
  mode: 'live' | 'readonly';
  cwd?: string;
  /** Originating surface if known (cli/telegram/daemon). */
  surface?: string;
  /** ISO 8601 timestamp — the session ledger file's mtime. */
  updatedAt?: string;
  /** First user message, truncated to ~80 chars. */
  title?: string;
  /** Liveness from presence records. Set for foreign sessions only. */
  alive?: boolean;
}

/** ~80-char cap on derived titles — matches {@link WebSessionSummary.title}. */
const TITLE_MAX_LEN = 80;

/**
 * How many leading ledger records to inspect when deriving `cwd`/`surface`/
 * `title`. The `meta` record is written once at ledger-open time (first line
 * in practice) and the first `user` turn typically follows within a handful
 * of records, so this window is generous without ever reading an entire
 * ledger just to build a list-row preview — ledgers can grow arbitrarily
 * large over a long session.
 */
const HEAD_RECORD_SCAN_LIMIT = 20;

function truncateTitle(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > TITLE_MAX_LEN ? `${flat.slice(0, TITLE_MAX_LEN)}…` : flat;
}

/**
 * Best-effort head-of-ledger read: `cwd`/`surface` from the `meta` record and
 * `title` from the first `user` record, stopping after
 * {@link HEAD_RECORD_SCAN_LIMIT} records or once both are found.
 *
 * Never throws. `readLedger` re-throws non-ENOENT filesystem errors (e.g. a
 * permission error), and a session's ledger content can be malformed or
 * truncated — either way this returns whatever was gathered before the
 * failure (possibly nothing) rather than failing the caller's whole listing.
 */
async function readLedgerHead(
  sessionId: string,
): Promise<{ cwd?: string; surface?: string; title?: string }> {
  const out: { cwd?: string; surface?: string; title?: string } = {};
  try {
    let seen = 0;
    for await (const rec of readLedger(sessionId)) {
      seen += 1;
      if (rec.kind === 'meta') {
        if (rec.cwd !== undefined) out.cwd = rec.cwd;
        if (rec.surface !== undefined) out.surface = rec.surface;
      } else if (rec.kind === 'user' && out.title === undefined) {
        out.title = truncateTitle(rec.text);
      }
      if (out.title !== undefined && (out.cwd !== undefined || out.surface !== undefined)) break;
      if (seen >= HEAD_RECORD_SCAN_LIMIT) break;
    }
  } catch {
    // Malformed/partial/unreadable ledger — degrade to whatever was
    // gathered so far. This entry must not take down the whole listing.
  }
  return out;
}

/**
 * Scan the sessions dir for subdirectories holding an `events.jsonl` ledger,
 * returning `id -> ledger mtime` for every one that is readable.
 *
 * Never throws: an unreadable sessions root, a directory entry whose name
 * fails the session-id safety check, or a per-entry stat failure all degrade
 * to "not a listable session" rather than aborting the scan.
 */
async function scanLedgerSessions(): Promise<Map<string, Date>> {
  const found = new Map<string, Date>();
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(getSessionsDir(), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeLedgerSessionId(entry.name)) continue;
    try {
      const stat = await fsp.stat(getSessionLedgerPath(entry.name));
      if (stat.isFile()) found.set(entry.name, stat.mtime);
    } catch {
      // No events.jsonl, or unreadable — not a listable session. Skip it.
    }
  }
  return found;
}

/**
 * Live-presence session ids, or `null` if presence could not be read at all
 * (e.g. a misconfigured AFK_HOME throwing before the read-dir try/catch in
 * `readPresenceFiles` is even reached). `null` tells the caller to leave
 * every foreign session's `alive` field undefined rather than guessing.
 */
async function readAliveIds(): Promise<Set<string> | null> {
  try {
    const records = await readLivePresenceFiles();
    return new Set(records.map((r) => r.sessionId));
  } catch {
    return null;
  }
}

/** Newest-first comparator. Sessions with no `updatedAt` sort last, stably. */
function compareByUpdatedAtDesc(a: WebSessionSummary, b: WebSessionSummary): number {
  if (a.updatedAt === undefined && b.updatedAt === undefined) return 0;
  if (a.updatedAt === undefined) return 1;
  if (b.updatedAt === undefined) return -1;
  if (a.updatedAt > b.updatedAt) return -1;
  if (a.updatedAt < b.updatedAt) return 1;
  return 0;
}

/**
 * Enumerate agent sessions the web UI can show.
 *
 * `owned` are session ids created inside this process: they get
 * `mode: 'live'` (full duplex — elicitations can resolve here). Every other
 * session id — whether discovered on disk or absent from it — is
 * `mode: 'readonly'` (attach-only via ledger tail). Sorted newest-first by
 * `updatedAt`.
 *
 * Fully defensive: a malformed, partial, or unreadable ledger, a stat/scan
 * failure, or an unreadable presence directory degrades that one entry's
 * fields (or the `alive` annotation) — it never fails the whole listing.
 */
export async function listWebSessions(owned: Set<string>): Promise<WebSessionSummary[]> {
  const [onDisk, aliveIds] = await Promise.all([scanLedgerSessions(), readAliveIds()]);

  const ids = new Set<string>([...onDisk.keys(), ...owned]);

  const summaries = await Promise.all(
    [...ids].map(async (id): Promise<WebSessionSummary> => {
      const mode: 'live' | 'readonly' = owned.has(id) ? 'live' : 'readonly';
      const head = await readLedgerHead(id);
      const mtime = onDisk.get(id);

      const summary: WebSessionSummary = { id, mode };
      if (head.cwd !== undefined) summary.cwd = head.cwd;
      if (head.surface !== undefined) summary.surface = head.surface;
      if (head.title !== undefined) summary.title = head.title;
      if (mtime !== undefined) summary.updatedAt = mtime.toISOString();
      if (mode === 'readonly' && aliveIds !== null) summary.alive = aliveIds.has(id);
      return summary;
    }),
  );

  summaries.sort(compareByUpdatedAtDesc);
  return summaries;
}
