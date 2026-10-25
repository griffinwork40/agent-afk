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
import { IncrementalLineReader } from '../utils/jsonl.js';
import type { LedgerRecord } from './session-ledger.js';
import { isErrnoCode } from '../utils/errors.js';

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
    if (isErrnoCode(e, 'ENOENT')) return;
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
 * - Reset seals are nonterminal; inode replacement (or shrink) rebases framing
 *   and offsets. Other `closed` records terminate the tail.
 * - `fs.watch` on the ledger directory is the wakeup; a 250ms poll is the
 *   fallback — on macOS watch events are coalesced/dropped under load, so
 *   the poll floor is load-bearing, not belt-and-braces.
 */
/**
 * Identity of one ledger file generation (a `/clear` or `/rewind` replaces the
 * file). `dev`+`ino` alone is not enough: Linux filesystems reuse a freed inode
 * immediately, so a replacement can inherit the inode of an earlier generation
 * and SSE cursors (`<generation>:<position>`) from different generations would
 * collide. Birth time separates them; filesystems that report no birth time
 * (birthtimeMs 0) degrade to the previous dev+ino identity.
 */
export function ledgerGeneration(stat: { dev: number; ino: number; birthtimeMs: number }): string {
  return `${stat.dev}-${stat.ino}-${Math.trunc(stat.birthtimeMs)}`;
}

export async function* tailLedger(
  sessionId: string,
  opts?: {
    fromStart?: boolean;
    signal?: AbortSignal;
    /** Called before records from each file generation (including the first). */
    onGeneration?: (generation: string) => void;
    /** Called once the initial snapshot has been drained. */
    onCaughtUp?: () => void;
  },
): AsyncGenerator<LedgerRecord> {
  if (!isSafeLedgerSessionId(sessionId)) return;
  const ledgerPath = getSessionLedgerPath(sessionId);
  const ledgerDir = getSessionLedgerDir(sessionId);
  const { fromStart = false, signal } = opts ?? {};

  let fileOffset = 0;
  let lineReader = new IncrementalLineReader();
  let generation: string | undefined;
  let sawClosed = false;

  async function* readNewRecords(): AsyncGenerator<LedgerRecord> {
    let fd: fsp.FileHandle | null = null;
    try {
      fd = await fsp.open(ledgerPath, 'r');
      const stat = await fd.stat();
      const currentGeneration = ledgerGeneration(stat);
      if (generation !== currentGeneration || stat.size < fileOffset) {
        fileOffset = 0;
        lineReader = new IncrementalLineReader();
        generation = currentGeneration;
        opts?.onGeneration?.(generation);
      }
      if (stat.size <= fileOffset) return;
      const toRead = stat.size - fileOffset;
      const readBuf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fd.read(readBuf, 0, toRead, fileOffset);
      if (bytesRead === 0) return;
      fileOffset += bytesRead;
      for (const line of lineReader.feed(readBuf.toString('utf8', 0, bytesRead))) {
        const rec = parseRecord(line);
        if (!rec) continue;
        // /clear seals the old writer before replacing the file. Existing
        // readers must stay alive through that interval, not send session_end.
        if (rec.kind === 'closed' && rec.reason === 'reset') continue;
        if (rec.kind === 'closed') sawClosed = true;
        yield rec;
        if (sawClosed) return;
      }
    } catch (e) {
      if (!isErrnoCode(e, 'ENOENT')) {
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
      generation = ledgerGeneration(stat);
      opts?.onGeneration?.(generation);
    } catch {
      // File doesn't exist yet — start from 0 and wait for it to appear.
    }
  } else {
    yield* readNewRecords();
    if (sawClosed) return;
  }
  opts?.onCaughtUp?.();

  let watcher: fs.FSWatcher | null = null;
  let watcherChange: (() => void) | null = null;

  const waitForChange = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(pollTimer);
        signal?.removeEventListener('abort', wake);
        watcherChange = null;
        resolve();
      };
      const pollTimer = setTimeout(wake, POLL_INTERVAL_MS);
      watcherChange = wake;
      signal?.addEventListener('abort', wake, { once: true });
      if (signal?.aborted) wake();
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
