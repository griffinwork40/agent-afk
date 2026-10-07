/**
 * Soft-delete GC sweep for the fact archive.
 *
 * Issue #1848, step 2. Built on the queryUnaccessed primitive introduced in
 * step 1 (memory-store.access.ts). Marks stale, never-accessed facts as
 * superseded (soft-delete: rows remain recoverable) without hard-deleting
 * any data.
 *
 * Design notes
 * ─────────────
 * • OFF by default (opt-in via AFK_MEMORY_GC_SWEEP_ENABLE=1). The issue
 *   notes "only pursue if noise becomes measurable"; enabling it on every
 *   install before users observe a real problem would be premature. An
 *   explicit opt-in keeps the blast radius zero for unaffected users while
 *   letting power users or CI jobs activate it.
 *
 * • SOFT-DELETE only. Eligible rows have their superseded_by set to their
 *   own id (self-reference sentinel). The rows stay in the database and are
 *   excluded from search results by the existing `superseded_by IS NULL`
 *   filter. No hard-delete pass is performed.
 *
 * • Conservative eligibility. A fact must clear ALL four gates:
 *     1. access_count = 0  (never retrieved since tracking started)
 *     2. created_at  older than AFK_MEMORY_GC_MIN_AGE_DAYS (default 30)
 *     3. created_at  on/after this database's tracking-start marker
 *     4. category NOT IN the excluded set (preference is always excluded)
 *
 * • Self-throttled by a stamp file (same pattern as witness-sweep.ts).
 *   Default cadence: at most once every 24 hours.
 *
 * • Fire-and-forget + .unref() at the call site. A failing sweep must
 *   never fail session construction. All async errors are swallowed.
 *
 * @module agent/memory/memory-gc-sweep
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../../config/env.js';
import { getMemoryDir } from '../../paths.js';
import { debugLog } from '../../utils/debug.js';
import type { FactCategory } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default minimum fact age (days) before a never-accessed fact becomes a
 * GC candidate. Only facts created since this database started tracking qualify.
 */
export const MEMORY_GC_MIN_AGE_DAYS_DEFAULT = 30;

/**
 * Minimum wall-clock gap between two GC sweeps. A stamp file in the memory
 * directory enforces this — the walk is O(facts in table), so without a stamp
 * every session start would re-run it.
 */
export const MEMORY_GC_SWEEP_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delay before the GC sweep fires after a root session starts.
 *
 * Slightly longer than the witness-sweep delay so the two sweeps do not
 * compete for I/O at exactly the same instant. Callers must `.unref()` the
 * timer so a short-lived process never waits for it.
 */
export const MEMORY_GC_SWEEP_START_DELAY_MS = 7_000;

/**
 * Soft-delete strategy: each archived row receives `superseded_by = id`
 * (self-reference). This passes the `REFERENCES facts(id)` foreign key
 * constraint that `better-sqlite3` enforces, while being unambiguous as a GC
 * marker — no normal supersede chain ever produces `superseded_by = id`.
 *
 * Consumers distinguishing GC-archived rows from normal supersedes can check
 * `superseded_by = id`. Existing code that only checks `superseded_by IS NULL`
 * (e.g. searchFacts, queryUnaccessed) already excludes these rows correctly.
 *
 * There is no exported numeric sentinel — the marker is per-row (`fact.id`).
 *
 * **Restoring soft-deleted rows.** GC-archived facts are recoverable: each
 * archived row has `superseded_by = id` (self-reference). To restore a fact,
 * set `superseded_by = NULL` — e.g.:
 *
 * ```sql
 * UPDATE facts SET superseded_by = NULL WHERE id = <fact_id>;
 * ```
 *
 * To list all GC-archived facts for inspection:
 *
 * ```sql
 * SELECT * FROM facts WHERE superseded_by = id;
 * ```
 */

/**
 * Fact categories that are NEVER candidates for GC, regardless of age or
 * access count. Preferences record user identity and values — losing them
 * silently is a trust violation.
 */
export const GC_EXCLUDED_CATEGORIES: ReadonlySet<FactCategory> = new Set<FactCategory>([
  'preference',
]);

const STAMP_FILE = '.last-gc-sweep';
const DB_FILE = 'memory.db';

// ---------------------------------------------------------------------------
// Public result + options types
// ---------------------------------------------------------------------------

export interface MemoryGcSweepOptions {
  /**
   * Override the memory directory (tests only). Defaults to getMemoryDir().
   */
  memoryDir?: string;
  /**
   * Minimum fact age in days before eligibility. Defaults to
   * MEMORY_GC_MIN_AGE_DAYS_DEFAULT (30).
   */
  minAgeDays?: number;
  /**
   * Bypass the inter-sweep stamp. Tests and explicit operator runs only.
   */
  force?: boolean;
}

export interface MemoryGcSweepResult {
  /** True when disabled flag or stamp short-circuited the run. */
  skipped: boolean;
  /** Reason for skipping (set when skipped=true). */
  skipReason?: 'disabled' | 'too-soon' | 'no-db' | 'tracking-unknown';
  /**
   * Number of facts that matched the GC eligibility predicate (examined as
   * candidates). Always >= `archived`. A value greater than `archived` means
   * some candidates were skipped (e.g. due to a concurrent write between the
   * count query and the UPDATE). Equal to zero when `skipped=true`.
   */
  candidates: number;
  /** Number of facts soft-deleted (superseded_by set to the fact's own id). */
  archived: number;
  /** Set when the sweep encountered an error (swallowed to never fail session start). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = (skipReason: MemoryGcSweepResult['skipReason']): MemoryGcSweepResult => ({
  skipped: true,
  skipReason,
  candidates: 0,
  archived: 0,
});

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Returns true when the stamp says a sweep ran recently enough to skip.
 */
async function sweptRecently(dir: string, now: number): Promise<boolean> {
  try {
    const st = await stat(join(dir, STAMP_FILE));
    return now - st.mtimeMs < MEMORY_GC_SWEEP_MIN_INTERVAL_MS;
  } catch {
    return false; // no stamp yet — sweep
  }
}

/**
 * Build the comma-separated SQL placeholder list and the excluded category
 * values array for the WHERE IN clause.
 */
function buildExcludedFilter(): { placeholders: string; values: string[] } {
  const values = Array.from(GC_EXCLUDED_CATEGORIES);
  const placeholders = values.map(() => '?').join(', ');
  return { placeholders, values };
}

// ---------------------------------------------------------------------------
// Core sweep
// ---------------------------------------------------------------------------

/**
 * Run the soft-delete GC sweep against the fact archive.
 *
 * Contract: best-effort and never throws — a missing DB, permission error,
 * or mid-run race resolves to a skipped/zero result. GC housekeeping must
 * never be able to fail a session start.
 */
export async function sweepMemoryGc(
  options: MemoryGcSweepOptions = {},
): Promise<MemoryGcSweepResult> {
  // Opt-in guard: sweep is OFF by default.
  if (env.AFK_MEMORY_GC_SWEEP_ENABLE !== '1') return noop('disabled');

  const dir = options.memoryDir ?? getMemoryDir();
  const dbPath = join(dir, DB_FILE);
  const now = Date.now();

  try {
    if (options.force !== true && (await sweptRecently(dir, now))) {
      return noop('too-soon');
    }

    const minAgeDays = positiveNumber(
      options.minAgeDays?.toString() ?? env.AFK_MEMORY_GC_MIN_AGE_DAYS,
      MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
    );
    const cutoff = new Date(now - minAgeDays * 24 * 60 * 60 * 1000).toISOString();

    const { placeholders, values: excludedValues } = buildExcludedFilter();

    // Fail cleanly if the DB doesn't exist yet — without fileMustExist the
    // constructor silently creates an empty file, making this noop path
    // unreachable and leaving behind an artifact.
    if (!existsSync(dbPath)) return noop('no-db');

    let db: InstanceType<typeof Database>;
    try {
      db = new Database(dbPath, { fileMustExist: true });
    } catch {
      return noop('no-db');
    }

    try {
      db.pragma('busy_timeout = 5000');

      // Old installations have no trustworthy observation epoch. A sweep
      // must never initialize/migrate one itself, nor assume a release date.
      const hasMetadata = db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'memory_metadata'`).get();
      if (!hasMetadata) return noop('tracking-unknown');
      const marker = db.prepare(`SELECT value FROM memory_metadata
        WHERE key = 'tracking_started_at'`).get() as { value: string } | undefined;
      if (!marker || !Number.isFinite(Date.parse(marker.value))) return noop('tracking-unknown');
      const trackingStart = new Date(marker.value).toISOString();
      const predicateParams = [trackingStart, cutoff, ...excludedValues];

      // Count candidates first so that `candidates` reflects how many facts
      // matched the predicate — not just how many were changed.  The two
      // values can differ under concurrent writes, but that is acceptable:
      // candidates is informational, not transactional.
      const countRow = db
        .prepare(
          `SELECT COUNT(*) AS n FROM facts
            WHERE access_count = 0
              AND created_at >= ?
              AND created_at < ?
              AND superseded_by IS NULL
              AND category NOT IN (${placeholders})`,
        )
        .get(...predicateParams) as { n: number };
      const candidates = countRow.n;

      // Soft-delete: UPDATE directly with the full eligibility predicate.
      // The epoch floor (created_at >= tracking start) ensures pre-tracking
      // rows with access_count = 0 are treated as unknown, not unused.
      const info = db
        .prepare(
          `UPDATE facts
              SET superseded_by = id
            WHERE access_count = 0
              AND created_at >= ?
              AND created_at < ?
              AND superseded_by IS NULL
              AND category NOT IN (${placeholders})`,
        )
        .run(...predicateParams);

      const archived = info.changes;

      await touchStamp(dir, now);

      if (archived > 0) {
        debugLog(
          `[memory-gc-sweep] archived ${archived} fact(s) (${candidates} candidate(s) examined)`,
        );
      }

      return { skipped: false, candidates, archived };
    } finally {
      db.close();
    }
  } catch (err) {
    // Swallow all errors — GC must never fail session construction.
    const error = err instanceof Error ? err.message : String(err);
    debugLog(`[memory-gc-sweep] sweep error (swallowed): ${error}`);
    return {
      skipped: false,
      candidates: 0,
      archived: 0,
      error,
    };
  }
}

async function touchStamp(dir: string, now: number): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STAMP_FILE), `${new Date(now).toISOString()}\n`, {
      mode: 0o600,
    });
  } catch {
    // stamp is an optimization, not a correctness requirement
  }
}
