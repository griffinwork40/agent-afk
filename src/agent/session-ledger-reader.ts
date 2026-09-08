/**
 * Read-side utilities for the per-session durable event ledger.
 *
 * Extracted from session-ledger.ts to keep that writer module under the
 * 350-LOC ceiling while the projection function grows to carry richer event
 * kinds (Wave 1, Step 1B).
 *
 * @module agent/session-ledger-reader
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import { getSessionLedgerDir, getSessionLedgerPath, isSafeLedgerSessionId } from '../paths.js';
import type { LedgerRecord } from './session-ledger.js';

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/** Parse one ledger line; returns null for blank/malformed lines. */
export function parseRecord(line: string): LedgerRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as LedgerRecord;
    if (parsed.v !== 1 || typeof parsed.ts !== 'number' || typeof parsed.kind !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Whether a ledger file exists for the given session id. */
export async function ledgerExists(sessionId: string): Promise<boolean> {
  if (!isSafeLedgerSessionId(sessionId)) return false;
  try {
    await fsp.access(getSessionLedgerPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

/** Read all records from a session ledger (ENOENT → zero records). */
export async function* readLedger(sessionId: string): AsyncGenerator<LedgerRecord> {
  if (!isSafeLedgerSessionId(sessionId)) return;
  let fd: fsp.FileHandle;
  try {
    fd = await fsp.open(getSessionLedgerPath(sessionId), 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  try {
    const rl = readline.createInterface({
      input: fd.createReadStream({ encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const rec = parseRecord(line);
      if (rec) yield rec;
    }
  } finally {
    await fd.close();
  }
}

const POLL_INTERVAL_MS = 250;

/**
 * Tail a session ledger — for live following from another process.
 *
 * - `fromStart: true` replays existing records first; otherwise starts at
 *   the current end of file (or 0 if the file doesn't exist yet).
 * - Yields until a `closed` record is read or `signal` aborts.
 * - `fs.watch` on the ledger directory is the wakeup; a 250ms poll is the
 *   fallback — on macOS watch events are coalesced/dropped under load, so
 *   the poll floor is load-bearing, not belt-and-braces.
 */
export async function* tailLedger(
  sessionId: string,
  opts?: { fromStart?: boolean; signal?: AbortSignal },
): AsyncGenerator<LedgerRecord> {
  if (!isSafeLedgerSessionId(sessionId)) return;
  const ledgerPath = getSessionLedgerPath(sessionId);
  const ledgerDir = getSessionLedgerDir(sessionId);
  const { fromStart = false, signal } = opts ?? {};

  let fileOffset = 0;
  let buffer = '';
  let sawClosed = false;

  async function* readNewRecords(): AsyncGenerator<LedgerRecord> {
    let fd: fsp.FileHandle | null = null;
    try {
      fd = await fsp.open(ledgerPath, 'r');
      const stat = await fd.stat();
      if (stat.size <= fileOffset) return;
      const toRead = stat.size - fileOffset;
      const readBuf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fd.read(readBuf, 0, toRead, fileOffset);
      if (bytesRead === 0) return;
      fileOffset += bytesRead;
      buffer += readBuf.toString('utf8', 0, bytesRead);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const rec = parseRecord(line);
        if (!rec) continue;
        if (rec.kind === 'closed') sawClosed = true;
        yield rec;
        if (sawClosed) return;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[afk] session-ledger: tail read error for ${sessionId}: ${String(e)}\n`);
      }
    } finally {
      if (fd) await fd.close().catch(() => { /* ignore */ });
    }
  }

  if (!fromStart) {
    try {
      const stat = await fsp.stat(ledgerPath);
      fileOffset = stat.size;
    } catch {
      // File doesn't exist yet — start from 0 and wait for it to appear.
    }
  } else {
    yield* readNewRecords();
    if (sawClosed) return;
  }

  let watcher: fs.FSWatcher | null = null;
  let watcherChange: (() => void) | null = null;

  const waitForChange = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const pollTimer = setTimeout(() => {
        watcherChange = null;
        resolve();
      }, POLL_INTERVAL_MS);
      watcherChange = () => {
        clearTimeout(pollTimer);
        watcherChange = null;
        resolve();
      };
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(pollTimer);
          watcherChange = null;
          resolve();
        },
        { once: true },
      );
    });

  try {
    // Watch the parent dir, not the file — the file may not exist yet.
    watcher = fs.watch(ledgerDir, { persistent: false }, () => {
      watcherChange?.();
    });
  } catch {
    // Pure polling fallback.
  }

  try {
    while (!signal?.aborted && !sawClosed) {
      await waitForChange();
      if (signal?.aborted) break;
      yield* readNewRecords();
    }
  } finally {
    watcher?.close();
  }
}
