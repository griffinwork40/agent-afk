/**
 * Sessions aggregator — reads ~/.afk/state/sessions/*.json and aggregates
 * cost and combined token totals by day/model/surface.
 *
 * Privacy invariants:
 *   - `telegramChatId` is NEVER read, stored, or forwarded.
 *   - Only `startedAt`, `model`, `source`, `totalCostUsd`, and `totalTokens`
 *     fields are accessed.
 *
 * @module insights/aggregators/sessions
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionsDir } from '../../paths.js';
import type { InsightsOptions, SessionAggregates } from '../types.js';

// ---------------------------------------------------------------------------
// Zero aggregates factory
// ---------------------------------------------------------------------------

export function zeroSessionAggregates(): SessionAggregates {
  return {
    totalSessions: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    byDay: {},
    byModel: {},
    bySurface: {},
  };
}

// ---------------------------------------------------------------------------
// Helper: increment a breakdown record
// ---------------------------------------------------------------------------

function incrementBreakdown(
  rec: Record<string, { costUsd: number; sessions: number }>,
  key: string,
  costUsd: number,
): void {
  if (!rec[key]) {
    rec[key] = { costUsd: 0, sessions: 0 };
  }
  rec[key]!.costUsd += costUsd;
  rec[key]!.sessions += 1;
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Read all session sidecar files within the `options.days` lookback window
 * and return aggregated metrics. Never throws — returns zero aggregates when
 * the sessions directory is missing or all files are malformed.
 */
export function aggregateSessions(options: InsightsOptions): SessionAggregates {
  const agg = zeroSessionAggregates();

  // Determine the sessions directory — support afkHome override for tests.
  const sessionsDir = options.afkHome
    ? join(options.afkHome, 'state', 'sessions')
    : getSessionsDir();

  if (!existsSync(sessionsDir)) {
    return agg;
  }

  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return agg;
  }

  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;

  for (const file of files) {
    const filePath = join(sessionsDir, file);

    // Cheap pre-filter (mirrors the traces aggregator): a sidecar's mtime (its
    // last write) is always >= the session's startedAt, so an mtime before the
    // cutoff means the session started outside the window — skip WITHOUT reading
    // the file. The precise startedAt check below stays the authoritative filter
    // for any file that passes this gate.
    try {
      if (statSync(filePath).mtimeMs < cutoffMs) {
        continue;
      }
    } catch {
      continue; // can't stat — skip
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const session = JSON.parse(raw) as Record<string, unknown>;

      // Privacy: explicitly skip telegramChatId — do NOT use or forward it.
      // We only extract the operational fields we need.
      const startedAt = typeof session['startedAt'] === 'number' ? session['startedAt'] : null;

      // Skip sessions outside the time window.
      if (startedAt === null || startedAt < cutoffMs) {
        continue;
      }

      // Extract the operational fields.
      const costUsd =
        typeof session['totalCostUsd'] === 'number' ? session['totalCostUsd'] : 0;
      const model =
        typeof session['model'] === 'string' && session['model'] !== ''
          ? session['model']
          : 'unknown';
      const surface =
        typeof session['source'] === 'string' && session['source'] !== ''
          ? session['source']
          : 'cli';

      // Token total — the session sidecar stores only a single combined
      // `totalTokens` (input + output + cache). It does NOT carry an
      // input/output split, and there is no `usage` object on the sidecar.
      // The real per-direction breakdown is sourced from witness trace
      // closure events in the traces aggregator; here we sum the coarse total.
      const totalTokens =
        typeof session['totalTokens'] === 'number' ? session['totalTokens'] : 0;

      // Day key for time-series breakdown.
      const dayKey = new Date(startedAt).toISOString().slice(0, 10); // 'YYYY-MM-DD'

      agg.totalSessions += 1;
      agg.totalCostUsd += costUsd;
      agg.totalTokens += totalTokens;

      incrementBreakdown(agg.byDay, dayKey, costUsd);
      incrementBreakdown(agg.byModel, model, costUsd);
      incrementBreakdown(agg.bySurface, surface, costUsd);
    } catch {
      // Malformed/unreadable file — skip silently.
    }
  }

  return agg;
}
