/**
 * Nightly delayed-relabel job (M2).
 *
 * Scans the outcome store for records with state='provisional'; for each:
 *   1. Runs delayed LFs against the record's OWN copied artifacts (never depends
 *      on session JSON still existing).
 *   2. Calls upsertVotes to merge results and re-combine.
 *   3. Marks the record 'settled' once every probe has resolved OR settles_after
 *      has passed.
 *
 * Delayed LFs run here:
 *   - pr_fate          (strong, merged +1 / closed unmerged -1 / open past 14d abstains)
 *   - commit_survival  (strong, ancestor of origin default branch after 7d; revert -1)
 *   - fix_of_fix       (weak -1, cannot flip succeeded; uses lf-fof.ts)
 *   - ci               (weak, gh pr checks; uses lf-ci.ts)
 *
 * Error handling: any single-record failure is caught and logged. The batch
 * continues. GH failures and missing/non-git cwd skip the record (it remains
 * provisional and will be retried next night). The job never throws at the
 * top level.
 *
 * Concurrency: bounded to CONCURRENCY_LIMIT parallel probes to avoid
 * GH rate-limit storms.
 *
 * Design: docs/proposals/verified-outcome.md § Delayed LFs
 */

import { existsSync } from 'node:fs';
import type { Vote, VerifiedOutcome } from './schema.js';
import { listRecords, readRecord, writeRecord, upsertVotes } from './store.js';
import { combine } from './combine.js';
import {
  lfCommitSurvival,
  realFetchPrState,
  realCheckAncestor,
  realCheckRevert,
} from './lf-delayed.js';
import type { FetchPrState, CheckAncestor, CheckRevert } from './lf-delayed.js';
import { lfCi, realExecFnCi } from './lf-ci.js';
import type { ExecFnCi } from './lf-ci.js';
import { lfFixOfFix, realExecFnFof } from './lf-fof.js';
import type { ExecFnFof } from './lf-fof.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of records to process in one job run. */
const DEFAULT_LIMIT = 200;

/** Parallel probe concurrency — keeps GH rate-limit pressure low. */
const CONCURRENCY_LIMIT = 4;

/**
 * How many days past settles_after before we force-settle a still-provisional
 * record (guards against records that can never resolve, e.g. deleted repos).
 */
const FORCE_SETTLE_GRACE_DAYS = 2;

/** Minimum days open before pr_fate abstains (14 per design). */
const PR_OPEN_ABSTAIN_DAYS = 14;

// ---------------------------------------------------------------------------
// Injectable dependencies (real impls at bottom; fakes in tests)
// ---------------------------------------------------------------------------

export interface RelabelDeps {
  fetchPrState: FetchPrState;
  checkAncestor: CheckAncestor;
  checkRevert: CheckRevert;
  execFnCi: ExecFnCi;
  execFnFof: ExecFnFof;
  now: () => Date;
  outcomesDir?: string;
}

export const realRelabelDeps: RelabelDeps = {
  fetchPrState: realFetchPrState,
  checkAncestor: realCheckAncestor,
  checkRevert: realCheckRevert,
  execFnCi: realExecFnCi,
  execFnFof: realExecFnFof,
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Job options
// ---------------------------------------------------------------------------

export interface RelabelJobOptions {
  limit?: number;
  dryRun?: boolean;
  deps?: RelabelDeps;
  outcomesDir?: string;
}

// ---------------------------------------------------------------------------
// Job result summary
// ---------------------------------------------------------------------------

export interface RelabelJobResult {
  scanned: number;
  settled: number;
  updated: number;
  skipped: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// pr_fate with 14-day open abstain
// ---------------------------------------------------------------------------

/**
 * Wraps lfPrFate to add the 14-day open abstain:
 * a PR that has been open for > PR_OPEN_ABSTAIN_DAYS is treated as abstained
 * (the session may have committed elsewhere; we can't blame the PR).
 */
async function runPrFate(
  record: VerifiedOutcome,
  deps: RelabelDeps,
  nowStr: string,
): Promise<Vote[]> {
  const { prs } = record.artifacts;
  if (prs.length === 0) return [];

  const prFateVotes: Vote[] = [];

  for (const url of prs) {
    // Fetch state for the single PR
    const state = await deps.fetchPrState(url);
    if (state === null) continue;

    const nowMs = deps.now().getTime();

    if (state.state === 'MERGED') {
      prFateVotes.push({
        lf: 'pr_fate',
        vote: 1,
        strength: 'strong',
        evidence: `PR ${url} state=MERGED mergedAt=${state.mergedAt ?? 'unknown'}`,
        observed_at: nowStr,
      });
    } else if (state.state === 'CLOSED') {
      prFateVotes.push({
        lf: 'pr_fate',
        vote: -1,
        strength: 'strong',
        severity: 'major' as const,
        evidence: `PR ${url} state=CLOSED (unmerged)`,
        observed_at: nowStr,
      });
    } else {
      // OPEN — abstain unless it has been open > 14 days
      const openMs = PR_OPEN_ABSTAIN_DAYS * 24 * 60 * 60 * 1000;
      const settlesMs = record.settles_after ? new Date(record.settles_after).getTime() : 0;
      if (nowMs - settlesMs > openMs) {
        // Force abstain by not pushing — pr_fate simply never resolves for this PR
        // The record will be settled by force-settle logic below
      }
      // No vote pushed for OPEN (abstain)
    }
  }

  return prFateVotes;
}

// ---------------------------------------------------------------------------
// Settle logic
// ---------------------------------------------------------------------------

/**
 * Return true when all delayed probes have either voted or irreversibly abstained.
 *
 * A record can be settled when:
 *   - All PRs have reached a terminal state (MERGED or CLOSED), OR
 *   - settles_after + FORCE_SETTLE_GRACE_DAYS has passed.
 */
function shouldSettle(
  record: VerifiedOutcome,
  prFateVotes: Vote[],
  nowMs: number,
): boolean {
  const settlesAfterMs = record.settles_after
    ? new Date(record.settles_after).getTime()
    : null;

  // Force-settle if the grace window has passed
  if (settlesAfterMs !== null) {
    const gracePastMs = (FORCE_SETTLE_GRACE_DAYS * 24 * 60 * 60 * 1000);
    if (nowMs > settlesAfterMs + gracePastMs) return true;
  }

  // Settle if every PR has a terminal pr_fate vote
  const { prs } = record.artifacts;
  if (prs.length === 0) return settlesAfterMs !== null && nowMs > settlesAfterMs;

  const terminalPrUrls = new Set(
    prFateVotes.filter((v) => v.lf === 'pr_fate').map((v) => {
      // Extract PR URL from evidence string
      const m = /PR (https:\/\/github\.com\/[^\s]+)/.exec(v.evidence);
      return m ? m[1] : '';
    }),
  );

  return prs.every((url) => terminalPrUrls.has(url));
}

// ---------------------------------------------------------------------------
// Process a single record
// ---------------------------------------------------------------------------

export interface ProcessResult {
  status: 'settled' | 'updated' | 'skipped' | 'error';
  reason?: string;
}

export async function processRecord(
  sessionId: string,
  deps: RelabelDeps,
  dryRun: boolean,
  outcomesDir?: string,
): Promise<ProcessResult> {
  let record: VerifiedOutcome | undefined;
  try {
    record = readRecord(sessionId, outcomesDir);
  } catch {
    return { status: 'error', reason: 'read failed' };
  }

  if (!record || record.state !== 'provisional') {
    return { status: 'skipped', reason: 'not provisional' };
  }

  const nowDate = deps.now();
  const nowStr = nowDate.toISOString();
  const { commits, prs, repo } = record.artifacts;

  // Skip if no artifacts — nothing to probe
  if (commits.length === 0 && prs.length === 0) {
    // May still need to settle by time
    const settlesAfterMs = record.settles_after ? new Date(record.settles_after).getTime() : null;
    if (settlesAfterMs && nowDate.getTime() > settlesAfterMs) {
      if (!dryRun) {
        upsertVotes(sessionId, [], undefined, { outcomesDir });
        // Force settle by writing state directly — upsertVotes doesn't force-settle
        _forceSettle(sessionId, nowStr, outcomesDir);
      }
      return { status: 'settled', reason: 'settles_after passed; no artifacts' };
    }
    return { status: 'skipped', reason: 'no artifacts' };
  }

  // Validate cwd / repo for git-based LFs
  const repoCwd = repo && existsSync(repo) ? repo : null;

  // Shared GH cache: avoids fetching the same PR state twice in one record
  const ciCache: Map<string, 'passed' | 'failed' | 'pending' | 'none' | 'error'> = new Map();

  // Run all delayed LFs
  const newVotes: Vote[] = [];

  try {
    // 1. pr_fate
    const prFateVotes = await runPrFate(record, deps, nowStr);
    newVotes.push(...prFateVotes);

    // 2. commit_survival (only after 7 days)
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const settlesAfterMs = record.settles_after ? new Date(record.settles_after).getTime() : 0;
    if (repoCwd && nowDate.getTime() - settlesAfterMs >= sevenDaysMs) {
      const survivalVotes = await lfCommitSurvival(
        commits,
        repoCwd,
        deps.checkAncestor,
        deps.checkRevert,
        nowStr,
      );
      newVotes.push(...survivalVotes);
    }

    // 3. fix_of_fix (weak -1, can never flip succeeded)
    if (prs.length > 0) {
      const fofVotes = await lfFixOfFix(
        prs,
        record.settles_after,
        deps.execFnFof,
        nowStr,
        nowDate,
      );
      newVotes.push(...fofVotes);
    }

    // 4. ci (weak)
    if (prs.length > 0) {
      const ciVotes = await lfCi(prs, deps.execFnCi, nowStr, ciCache);
      newVotes.push(...ciVotes);
    }
  } catch {
    // A probe threw unexpectedly — skip this record; retry next night
    return { status: 'skipped', reason: 'probe threw unexpectedly' };
  }

  // Determine settle
  const prFateVotes = newVotes.filter((v) => v.lf === 'pr_fate');
  const settle = shouldSettle(record, [...record.votes, ...prFateVotes], nowDate.getTime());

  if (dryRun) {
    const action = settle ? 'settled' : 'updated';
    return { status: action, reason: `dry-run: ${newVotes.length} new votes` };
  }

  // Upsert votes
  upsertVotes(sessionId, newVotes, undefined, { outcomesDir });

  if (settle) {
    _forceSettle(sessionId, nowStr, outcomesDir);
    return { status: 'settled', reason: `${newVotes.length} new votes` };
  }

  return { status: 'updated', reason: `${newVotes.length} new votes` };
}

/**
 * Force-set state='settled' on a record without changing any votes.
 * Used when the settle condition is met after upsertVotes has run.
 */
function _forceSettle(
  sessionId: string,
  nowStr: string,
  outcomesDir?: string,
): void {
  const record = readRecord(sessionId, outcomesDir);
  if (!record || record.state === 'settled') return;

  writeRecord({ ...record, state: 'settled', settles_after: nowStr }, outcomesDir);
}

// ---------------------------------------------------------------------------
// Run the full batch
// ---------------------------------------------------------------------------

/**
 * Run the nightly relabel job. Scans for provisional records, runs delayed LFs,
 * upserts votes, and settles records. Never throws.
 *
 * Returns a summary suitable for the one-line job output.
 */
export async function runRelabelJob(
  opts: RelabelJobOptions = {},
): Promise<RelabelJobResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const dryRun = opts.dryRun ?? false;
  const deps = opts.deps ?? realRelabelDeps;
  const outcomesDir = opts.outcomesDir;

  const result: RelabelJobResult = {
    scanned: 0,
    settled: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  // Invariant: the limit caps PROVISIONAL records, never the directory scan.
  // Every root session writes a record and most settle immediately, so
  // capping the scan would re-read the same first N (mostly settled) files
  // each night and starve every provisional record past them.
  let sessionIds: string[];
  try {
    sessionIds = listRecords(Number.POSITIVE_INFINITY, outcomesDir);
  } catch {
    return result;
  }

  // Filter to provisional records only (quick in-memory pass before probing)
  const provisional: string[] = [];
  for (const id of sessionIds) {
    try {
      const rec = readRecord(id, outcomesDir);
      if (rec && rec.state === 'provisional') provisional.push(id);
      if (provisional.length >= limit) break;
    } catch {
      // skip unreadable
    }
  }
  result.scanned = provisional.length;

  // Process in bounded-concurrency batches
  for (let i = 0; i < provisional.length; i += CONCURRENCY_LIMIT) {
    const batch = provisional.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map((id) => processRecord(id, deps, dryRun, outcomesDir).catch((): ProcessResult => ({ status: 'error', reason: 'unexpected' }))),
    );
    for (const r of batchResults) {
      if (r.status === 'settled') result.settled++;
      else if (r.status === 'updated') result.updated++;
      else if (r.status === 'skipped') result.skipped++;
      else result.errors++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Backfill: rescore settled unknown records with combiner v2
// ---------------------------------------------------------------------------

export interface RescoreResult {
  scanned: number;
  relabeled: number;
  skipped: number;
  errors: number;
}

export interface RescoreOptions {
  limit?: number;
  dryRun?: boolean;
  outcomesDir?: string;
}

/**
 * Re-apply combiner v2 to settled records whose label is 'unknown'.
 *
 * This is the backfill for the 564 records produced by combiner v1 that could
 * not be labeled because v1 required strong positive proof. Combiner v2 adds
 * good-by-default (rules 6 and 7) which labels those as succeeded or still
 * unknown based on the absence of negative votes.
 *
 * Safety properties:
 *   - Only re-runs the combiner on existing votes — no remote probes.
 *   - Preserves the existing history[] by appending a new entry on label change.
 *   - Does NOT change state (remains settled).
 *   - Opt-in only: only called when --rescore-settled is passed explicitly.
 */
export async function rescoreSettledUnknown(
  opts: RescoreOptions = {},
): Promise<RescoreResult> {
  const limit = opts.limit ?? 200;
  const dryRun = opts.dryRun ?? false;
  const outcomesDir = opts.outcomesDir;

  const result: RescoreResult = { scanned: 0, relabeled: 0, skipped: 0, errors: 0 };

  let allIds: string[];
  try {
    allIds = listRecords(Number.POSITIVE_INFINITY, outcomesDir);
  } catch {
    return result;
  }

  // Filter to settled unknown records
  const candidates: string[] = [];
  for (const id of allIds) {
    try {
      const rec = readRecord(id, outcomesDir);
      if (rec && rec.state === 'settled' && rec.label === 'unknown') {
        candidates.push(id);
      }
      if (candidates.length >= limit) break;
    } catch {
      // skip unreadable
    }
  }
  result.scanned = candidates.length;

  const nowStr = new Date().toISOString();

  for (const id of candidates) {
    try {
      const rec = readRecord(id, outcomesDir);
      if (!rec || rec.state !== 'settled' || rec.label !== 'unknown') {
        result.skipped++;
        continue;
      }

      // Re-apply combiner v2 with settleWindowPassed=true (these are settled records).
      // Derive normalClosure from stored closure_reason: treat missing as normal
      // (old records without the field; conservative — we don't know it was abnormal).
      // Only 'abort' and 'iteration_cap' are non-normal.
      const normalClosure =
        rec.closure_reason === undefined ||
        rec.closure_reason === 'normal';

      const { label, confidence, basis } = combine({
        votes: rec.votes,
        selfReport: rec.self_report,
        artifacts: rec.artifacts,
        settleWindowPassed: true,
        normalClosure,
      });

      if (label === rec.label) {
        result.skipped++;
        continue;
      }

      if (dryRun) {
        result.relabeled++;
        continue;
      }

      // Write updated record with history entry
      const updated: VerifiedOutcome = {
        ...rec,
        label,
        confidence,
        basis,
        history: [
          ...rec.history,
          { at: nowStr, label, reason: 'rescore-settled: combiner v2 good-by-default' },
        ],
      };
      writeRecord(updated, outcomesDir);
      result.relabeled++;
    } catch {
      result.errors++;
    }
  }

  return result;
}
