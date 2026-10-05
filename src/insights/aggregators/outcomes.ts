/**
 * Outcomes KPI aggregator — reads the outcome store and reports per-ISO-week
 * counts of succeeded (split by basis), failed+interrupted (bad), blocked, and
 * unknown labels.
 *
 * Privacy invariants:
 *   - No prompt content, no session IDs, no file paths in output.
 *   - Only label, basis, confidence, and settles_after fields are accessed.
 *
 * @module insights/aggregators/outcomes
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOutcomesDir } from '../../paths.js';
import type { InsightsOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-ISO-week outcome counts. */
export interface OutcomeWeekCounts {
  /** Count of succeeded records with basis='proven' */
  goodProven: number;
  /** Count of succeeded records with basis='no_bad_signals' or basis absent */
  goodPressumed: number;
  /** Count of failed + interrupted records */
  bad: number;
  /** Count of blocked records */
  blocked: number;
  /** Count of unknown records */
  unknown: number;
}

/** Full outcomes KPI aggregate. */
export interface OutcomeAggregates {
  /** key: ISO week string 'YYYY-Www' */
  byWeek: Record<string, OutcomeWeekCounts>;
  /** Total records scanned in window */
  totalRecords: number;
  /** Records skipped due to parse errors */
  parseErrors: number;
}

// ---------------------------------------------------------------------------
// Zero aggregates factory
// ---------------------------------------------------------------------------

export function zeroOutcomeAggregates(): OutcomeAggregates {
  return { byWeek: {}, totalRecords: 0, parseErrors: 0 };
}

function zeroWeekCounts(): OutcomeWeekCounts {
  return { goodProven: 0, goodPressumed: 0, bad: 0, blocked: 0, unknown: 0 };
}

// ---------------------------------------------------------------------------
// ISO week key derivation
// ---------------------------------------------------------------------------

/**
 * Convert a Date to an ISO week key 'YYYY-Www'.
 * Uses the ISO 8601 definition: weeks start Monday, week 1 contains the first
 * Thursday of the year.
 */
export function isoWeekKey(date: Date): string {
  // Copy date and shift to the Thursday of the same ISO week (ISO weeks start Mon)
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Get day of week (0=Sun), shift to Mon=0
  const dow = (d.getUTCDay() + 6) % 7;
  // Move to Thursday
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const year = d.getUTCFullYear();
  // Jan 4 is always in week 1 (ISO 8601 rule)
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const weekNum = Math.floor((d.getTime() - jan4.getTime() + jan4Dow * 86400000) / (7 * 86400000)) + 1;
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Aggregate outcome KPIs from the outcome store.
 * Reads records from getOutcomesDir() or options.afkHome override.
 * Only processes settled records whose settles_after (or file mtime fallback)
 * falls within the requested window.
 */
export function aggregateOutcomes(options: InsightsOptions & { outcomesDir?: string }): OutcomeAggregates {
  const outcomesDir = options.outcomesDir
    ?? (options.afkHome
      ? join(options.afkHome, 'agent-framework', 'outcomes')
      : getOutcomesDir());

  if (!existsSync(outcomesDir)) return zeroOutcomeAggregates();

  const windowMs = options.days * 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - windowMs;

  const result = zeroOutcomeAggregates();

  let entries: string[];
  try {
    entries = readdirSync(outcomesDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;

    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(outcomesDir, entry), 'utf8'),
      );

      if (typeof raw !== 'object' || raw === null) {
        result.parseErrors++;
        continue;
      }

      const rec = raw as Record<string, unknown>;

      // Only count settled records
      if (rec['state'] !== 'settled') continue;

      // Determine the date to bucket by — prefer settles_after, fall back to now
      const settlesAfterStr = rec['settles_after'];
      const dateStr =
        typeof settlesAfterStr === 'string' ? settlesAfterStr : new Date().toISOString();
      const dateMs = new Date(dateStr).getTime();

      if (isNaN(dateMs) || dateMs < cutoffMs) continue;

      result.totalRecords++;

      const weekKey = isoWeekKey(new Date(dateMs));
      const bucket = (result.byWeek[weekKey] ??= zeroWeekCounts());

      const label = rec['label'];
      const basis = rec['basis'];

      if (label === 'succeeded') {
        if (basis === 'proven') {
          bucket.goodProven++;
        } else {
          // 'no_bad_signals' or absent (pre-v2 succeeded records count as presumed)
          bucket.goodPressumed++;
        }
      } else if (label === 'failed' || label === 'interrupted') {
        bucket.bad++;
      } else if (label === 'blocked') {
        bucket.blocked++;
      } else {
        bucket.unknown++;
      }
    } catch {
      result.parseErrors++;
    }
  }

  return result;
}
