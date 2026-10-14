/**
 * Fact mutation helpers for the cross-session memory store.
 *
 * Contains the supersedeFact logic extracted from MemoryStore to keep
 * memory-store.ts under the 350-code-line ceiling. All functions take
 * explicit `db` / `dir` parameters; no closures over MemoryStore internals.
 *
 * @module agent/memory/memory-store.facts
 */

import type BetterSqlite3 from 'better-sqlite3';
import { appendWAL } from './memory-store.wal.js';
import type { Fact } from './types.js';

/**
 * Insert a replacement fact row, wire the superseded_by pointer, and record
 * both WAL entries. Returns the new fact id.
 *
 * Invariant: if the INSERT violates the UNIQUE fingerprint constraint (same
 * content/created_at/session_id/category), that means a WAL replay has
 * already inserted this row. We locate it by the 4-field fingerprint and
 * return its id so the superseded_by pointer is still wired correctly
 * (idempotent, no data loss).
 */
export function supersedeFact(
  db: BetterSqlite3.Database,
  dir: string,
  factId: number,
  newContent: string,
  category?: string,
  evidence?: string | null,
): number {
  const old = db.prepare('SELECT * FROM facts WHERE id = ?').get(factId) as Fact | undefined;
  if (!old) throw new Error(`Fact ${factId} not found`);

  const now = new Date().toISOString();
  const resolvedCategory = category ?? old.category;
  // `undefined` = caller did not re-supply evidence → carry the prior
  // citation forward. An explicit `null` clears it; an explicit string
  // replaces it.
  const resolvedEvidence = evidence === undefined ? old.evidence : evidence;

  appendWAL(dir, {
    type: 'fact',
    timestamp: now,
    data: {
      session_id: old.session_id,
      created_at: now,
      category: resolvedCategory,
      content: newContent,
      source_surface: old.source_surface,
      evidence: resolvedEvidence,
    },
  });

  const stmt = db.prepare(`
    INSERT INTO facts (session_id, created_at, category, content, source_surface, confidence, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let newId: number;
  try {
    const result = stmt.run(
      old.session_id,
      now,
      resolvedCategory,
      newContent,
      old.source_surface,
      1.0,
      resolvedEvidence,
    );
    newId = Number(result.lastInsertRowid);
  } catch (e: unknown) {
    // UNIQUE constraint failure: the exact same (content, created_at,
    // session_id, category) fingerprint already exists — this is a WAL
    // replay re-applying a supersede that already landed.  Locate the
    // existing row and return its id so the superseded_by pointer is still
    // wired correctly (idempotent).
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
      const existing = db
        .prepare(
          `SELECT id FROM facts
             WHERE content = ?
               AND created_at = ?
               AND COALESCE(session_id, '') = COALESCE(?, '')
               AND category = ?
             LIMIT 1`,
        )
        .get(newContent, now, old.session_id ?? null, resolvedCategory) as
        | { id: number }
        | undefined;
      if (existing) {
        newId = existing.id;
      } else {
        throw e; // Unexpected — surface to caller.
      }
    } else {
      throw e;
    }
  }

  db.prepare('UPDATE facts SET superseded_by = ? WHERE id = ?').run(newId, factId);
  // C9: store 4-field fingerprints (content + created_at + session_id +
  // category) — the same fields covered by the UNIQUE index added in v2 —
  // so the supersede relationship survives a crash-then-replay scenario.
  // Including session_id and category avoids ambiguity when the same content
  // string appears under different categories or sessions.
  appendWAL(dir, {
    type: 'supersede',
    timestamp: now,
    data: {
      old_content: old.content,
      old_created_at: old.created_at,
      old_session_id: old.session_id ?? null,
      old_category: old.category,
      new_content: newContent,
      new_created_at: now,
      new_session_id: old.session_id ?? null,
      new_category: resolvedCategory,
      // Legacy fields kept for readers that haven't yet upgraded; can be
      // removed in a future cleanup pass once all WAL files have been replayed.
      old_fact_id: factId,
      new_fact_id: newId,
    },
  });
  return newId;
}
