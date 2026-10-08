/**
 * Aggregator for the pre-existing-defect ledger.
 *
 * Reads the ledger written by the SessionEnd hook, clusters records by
 * (repo, locus, signal), and returns the top-N recurring defects ranked by
 * recurrence count.
 *
 * Privacy invariants:
 *   - Only structural metadata is forwarded (repo path, locus token, signal
 *     kind, category, counts, timestamps). No assistant text, no session
 *     content.
 *
 * @module insights/aggregators/preexisting-defects
 */

import type { InsightsOptions } from '../types.js';
import type { DefectCluster } from '../../agent/preexisting-ledger/reader.js';
import { readLedgerRecords, clusterLedgerRecords } from '../../agent/preexisting-ledger/reader.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PreexistingDefectAggregates {
  /** Total raw ledger records parsed (before clustering). */
  totalRecords: number;
  /** Number of records skipped due to being outside the time window. */
  skippedOutOfWindow: number;
  /** Top recurring clusters, ranked by recurrence count desc. */
  topClusters: DefectCluster[];
}

// ---------------------------------------------------------------------------
// Zero aggregate factory
// ---------------------------------------------------------------------------

export function zeroPreexistingDefectAggregates(): PreexistingDefectAggregates {
  return { totalRecords: 0, skippedOutOfWindow: 0, topClusters: [] };
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/** Maximum clusters to surface in the insights report. */
const MAX_CLUSTERS = 20;

/**
 * Read the preexisting-defect ledger and aggregate recurring clusters within
 * the lookback window specified by `options.days`.
 *
 * Never throws — returns zero-aggregate when the ledger is absent or all
 * records are malformed.
 */
export function aggregatePreexistingDefects(
  options: InsightsOptions,
): PreexistingDefectAggregates {
  const records = readLedgerRecords();
  if (records.length === 0) return zeroPreexistingDefectAggregates();

  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;
  let skipped = 0;
  const inWindow = records.filter((r) => {
    const t = Date.parse(r.ts);
    if (isNaN(t) || t < cutoffMs) {
      skipped += 1;
      return false;
    }
    return true;
  });

  const clusters = clusterLedgerRecords(inWindow);

  return {
    totalRecords: records.length,
    skippedOutOfWindow: skipped,
    topClusters: clusters.slice(0, MAX_CLUSTERS),
  };
}
