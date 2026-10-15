/**
 * WAL (write-ahead log) append, replay, and validation for the cross-session
 * memory store.
 *
 * Extracted from memory-store.ts to keep that file under the 350-code-line
 * ceiling. All functions take explicit `db` / `dir` parameters; no closures
 * over MemoryStore internals.
 *
 * @module agent/memory/memory-store.wal
 */

import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, readFileSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { debugLog } from '../../utils/debug.js';
import { parseJsonlLines } from '../../utils/jsonl.js';
import type { WALEntry } from './types.js';

const WAL_FILE = 'memory-wal.jsonl';

const VALID_WAL_TYPES = new Set(['fact', 'session_start', 'session_end', 'supersede']);
const VALID_CATEGORIES = new Set(['preference', 'convention', 'decision', 'learning']);

export function isValidWALEntry(entry: unknown): entry is WALEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e['type'] !== 'string' || !VALID_WAL_TYPES.has(e['type'])) return false;
  if (typeof e['timestamp'] !== 'string') return false;
  if (!e['data'] || typeof e['data'] !== 'object') return false;
  if (e['type'] === 'fact') {
    const d = e['data'] as Record<string, unknown>;
    if (typeof d['category'] !== 'string' || !VALID_CATEGORIES.has(d['category'])) return false;
  }
  return true;
}

/** Append a WAL entry to the JSONL write-ahead log in `dir`. Non-fatal on I/O error. */
export function appendWAL(dir: string, entry: WALEntry): void {
  const walPath = join(dir, WAL_FILE);
  try {
    appendFileSync(walPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    debugLog('WAL append failed (non-fatal):', String(err));
  }
}

/**
 * Replay any pending WAL entries into `db`, then delete the WAL file.
 *
 * Returns the number of entries successfully replayed. Idempotent: if the WAL
 * file is absent or empty, returns 0 without modifying the DB.
 */
export function replayWAL(db: BetterSqlite3.Database, dir: string): number {
  const walPath = join(dir, WAL_FILE);
  if (!existsSync(walPath)) return 0;

  let replayed = 0;
  try {
    const raw = readFileSync(walPath, 'utf-8').trim();
    if (!raw) {
      unlinkSync(walPath);
      return 0;
    }

    for (const item of parseJsonlLines(raw, {
      onParseError: (l) => debugLog('WAL replay: skipping malformed line:', l.slice(0, 200)),
    })) {
      if (!isValidWALEntry(item)) {
        debugLog('WAL replay: skipping invalid entry:', JSON.stringify(item).slice(0, 200));
        continue;
      }
      const entry: WALEntry = item;
      try {
        if (entry.type === 'session_start') {
          const d = entry.data;
          db.prepare(`
            INSERT OR IGNORE INTO sessions (session_id, surface, started_at, actor)
            VALUES (?, ?, ?, ?)
          `).run(d['session_id'], d['surface'], d['started_at'], d['actor'] ?? null);
          replayed++;
        } else if (entry.type === 'session_end') {
          const d = entry.data;
          db.prepare(`
            UPDATE sessions SET ended_at = ?, summary = ?, outcome = ?
            WHERE session_id = ? AND ended_at IS NULL
          `).run(d['ended_at'], d['summary'], d['outcome'], d['session_id']);
          replayed++;
        } else if (entry.type === 'fact') {
          const d = entry.data;
          // Use 4-field idempotency check matching the UNIQUE index (v2+).
          const existing = db.prepare(
            'SELECT id FROM facts WHERE content = ? AND created_at = ? AND COALESCE(session_id,\'\') = ? AND category = ?',
          ).get(d['content'], d['created_at'], d['session_id'] ?? '', d['category'] ?? '');
          if (!existing) {
            db.prepare(`
              INSERT INTO facts (session_id, created_at, category, content, source_surface, evidence)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              d['session_id'] ?? null,
              d['created_at'],
              d['category'],
              d['content'],
              d['source_surface'] ?? 'cli',
              d['evidence'] ?? null,
            );
            replayed++;
          }
        } else if (entry.type === 'supersede') {
          replayed += replaySupersede(db, entry.data);
        }
      } catch (err) {
        debugLog('WAL replay: skipping malformed line:', String(err));
      }
    }
    unlinkSync(walPath);
  } catch (err) {
    debugLog('WAL file unreadable, skipping recovery:', String(err));
  }
  return replayed;
}

/**
 * Replay a single 'supersede' WAL entry. Returns 1 if the superseded_by
 * pointer was successfully wired, 0 if the rows could not be resolved.
 *
 * Invariant: C9 (v2) — prefer 4-field fingerprints (content + created_at +
 * session_id + category) matching the UNIQUE index added in v2. Fall back to
 * 2-field (content + created_at only) for WAL entries written by the v1 fix,
 * then to raw rowids for legacy entries.
 */
function replaySupersede(db: BetterSqlite3.Database, d: Record<string, unknown>): number {
  let resolvedOldId: number | undefined;
  let resolvedNewId: number | undefined;

  if (typeof d['old_content'] === 'string' && typeof d['old_created_at'] === 'string') {
    let oldRow: { id: number } | undefined;
    if (typeof d['old_session_id'] !== 'undefined' || typeof d['old_category'] === 'string') {
      // 4-field lookup (v2+ WAL entries).
      oldRow = db.prepare(
        'SELECT id FROM facts WHERE content = ? AND created_at = ? AND COALESCE(session_id,\'\') = ? AND category = ?',
      ).get(
        d['old_content'],
        d['old_created_at'],
        d['old_session_id'] ?? '',
        d['old_category'] ?? '',
      ) as { id: number } | undefined;
    }
    if (!oldRow) {
      // 2-field fallback (v1 WAL entries).
      oldRow = db.prepare(
        'SELECT id FROM facts WHERE content = ? AND created_at = ?',
      ).get(d['old_content'], d['old_created_at']) as { id: number } | undefined;
    }
    resolvedOldId = oldRow?.id;
  } else if (typeof d['old_fact_id'] === 'number') {
    resolvedOldId = d['old_fact_id'];
  }

  if (typeof d['new_content'] === 'string' && typeof d['new_created_at'] === 'string') {
    let newRow: { id: number } | undefined;
    if (typeof d['new_session_id'] !== 'undefined' || typeof d['new_category'] === 'string') {
      // 4-field lookup (v2+ WAL entries).
      newRow = db.prepare(
        'SELECT id FROM facts WHERE content = ? AND created_at = ? AND COALESCE(session_id,\'\') = ? AND category = ?',
      ).get(
        d['new_content'],
        d['new_created_at'],
        d['new_session_id'] ?? '',
        d['new_category'] ?? '',
      ) as { id: number } | undefined;
    }
    if (!newRow) {
      // 2-field fallback (v1 WAL entries).
      newRow = db.prepare(
        'SELECT id FROM facts WHERE content = ? AND created_at = ?',
      ).get(d['new_content'], d['new_created_at']) as { id: number } | undefined;
    }
    resolvedNewId = newRow?.id;
  } else if (typeof d['new_fact_id'] === 'number') {
    resolvedNewId = d['new_fact_id'];
  }

  if (typeof resolvedOldId === 'number' && typeof resolvedNewId === 'number') {
    db.prepare(
      'UPDATE facts SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL',
    ).run(resolvedNewId, resolvedOldId);
    return 1;
  }
  return 0;
}
