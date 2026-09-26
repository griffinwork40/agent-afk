/**
 * Eval-run pipeline recency guard.
 *
 * The eval pipeline (`afk improve eval-run`) is the regression safety net for
 * the improve pipeline's detectors and guardrails. If it goes many days without
 * running, regressions can accumulate silently — as happened in the
 * highest-velocity sprint that saw pass rate drop from 89 % to 75 % in 15 days
 * of silence (issue #2010).
 *
 * This module exposes {@link checkEvalPipelineRecency}, a pure function that
 * reads the most recent eval-run timestamp from the `.index.jsonl` artifact
 * log and returns a {@link PipelineRecencyResult} describing the staleness
 * state.  The caller (e.g. the `/ground-state` pre-flight check) decides how
 * to surface the result.
 *
 * ## Design invariants
 *
 * - **Cannot silently fail**: every error path returns a
 *   {@link PipelineRecencyResult} with `status: 'error'` and a `message`
 *   explaining what went wrong. The caller can then surface this as an
 *   observable warning finding even when the index is missing or unreadable.
 * - **Configurable threshold**: the staleness threshold is read from
 *   `AFK_EVAL_STALENESS_DAYS` (via `env`, never raw `process.env`).  Default
 *   is 7 days. Setting it to 0 disables the guard entirely.
 * - **Pure modulo I/O**: all FS reads are injectable via `ctx.readIndex`, so
 *   tests can exercise every code path without touching the filesystem.
 *
 * @module improve/eval-run/pipeline-recency
 */

import { existsSync, readFileSync } from 'fs';
import { env } from '../../config/env.js';
import { getEvalRunsIndexPath } from '../paths.js';
import { errorMessage } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default staleness threshold in days when AFK_EVAL_STALENESS_DAYS is unset. */
export const DEFAULT_STALENESS_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineRecencyStatus =
  /** The most recent eval-run is within the threshold — pipeline is healthy. */
  | 'fresh'
  /** The most recent eval-run is older than the threshold — action recommended. */
  | 'stale'
  /** No eval-runs have ever been recorded — pipeline has never run. */
  | 'never-run'
  /** The guard itself hit an error (file unreadable, parse failure, etc.). */
  | 'error'
  /** The guard is explicitly disabled (threshold == 0). */
  | 'disabled';

export interface PipelineRecencyResult {
  status: PipelineRecencyStatus;
  /** Most recent eval-run timestamp (ISO 8601) when at least one run exists. */
  lastRunAt: string | null;
  /** Age in whole days (floor) since the last run, or null when not applicable. */
  ageInDays: number | null;
  /**
   * Configured threshold in days. Present for all non-disabled, non-error
   * statuses so the caller can include the threshold in the warning text.
   */
  thresholdDays: number | null;
  /**
   * Human-readable message summarising the result. Always present so the
   * caller can surface it verbatim as a finding without additional formatting.
   */
  message: string;
}

// ---------------------------------------------------------------------------
// Context (injectable seams for testing)
// ---------------------------------------------------------------------------

export interface PipelineRecencyContext {
  /**
   * Override the clock. Defaults to `new Date()`.
   * Tests inject a fixed date so staleness arithmetic is deterministic.
   */
  now?: () => Date;
  /**
   * Override the index reader. Defaults to reading the real
   * `getEvalRunsIndexPath()` from the filesystem.
   * Tests inject a string to avoid filesystem access.
   */
  readIndex?: () => string | null;
}

// ---------------------------------------------------------------------------
// Index line type (minimal — we only need `timestamp`)
// ---------------------------------------------------------------------------

interface IndexLine {
  timestamp?: string;
  event?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve the configured staleness threshold in whole days.
 * Returns 0 when the guard is disabled, DEFAULT_STALENESS_DAYS when unset.
 *
 * Exported for unit testing; callers should use `checkEvalPipelineRecency`.
 */
export function resolveStalenessThreshold(): number {
  const raw = env.AFK_EVAL_STALENESS_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALENESS_DAYS;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) return DEFAULT_STALENESS_DAYS;
  return parsed;
}

/**
 * Read the eval-runs `.index.jsonl` and return the most recent `timestamp`
 * across all `event: "created"` lines. Returns `null` when the file is
 * absent, empty, or contains no parseable timestamp.
 *
 * Exported so tests can unit-test the parse logic without calling the full
 * `checkEvalPipelineRecency` function.
 */
export function parseLatestTimestamp(raw: string): string | null {
  let latest: string | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: IndexLine;
    try {
      parsed = JSON.parse(trimmed) as IndexLine;
    } catch {
      // Corrupt line — skip rather than abort.
      continue;
    }
    const ts = parsed.timestamp;
    if (typeof ts !== 'string' || ts === '') continue;
    if (latest === null || ts > latest) latest = ts;
  }
  return latest;
}

/**
 * Check whether the eval pipeline has run recently enough.
 *
 * This function is the sole entry point for the guard. It:
 *   1. Reads the configured threshold (from `AFK_EVAL_STALENESS_DAYS`).
 *   2. Reads the `.index.jsonl` artifact log to find the most recent timestamp.
 *   3. Computes the age in days against the provided (or real) clock.
 *   4. Returns a {@link PipelineRecencyResult} with status `fresh`, `stale`,
 *      `never-run`, `error`, or `disabled`.
 *
 * The function itself never throws — all error paths return
 * `status: 'error'` so the caller's pre-flight report can surface the
 * failure as a finding.
 */
export function checkEvalPipelineRecency(
  ctx: PipelineRecencyContext = {},
): PipelineRecencyResult {
  const thresholdDays = resolveStalenessThreshold();

  if (thresholdDays === 0) {
    return {
      status: 'disabled',
      lastRunAt: null,
      ageInDays: null,
      thresholdDays: 0,
      message: 'Eval-pipeline staleness guard is disabled (AFK_EVAL_STALENESS_DAYS=0).',
    };
  }

  // Read the index — either the injected reader or the real filesystem.
  let rawIndex: string | null;
  if (ctx.readIndex) {
    try {
      rawIndex = ctx.readIndex();
    } catch (err) {
      return {
        status: 'error',
        lastRunAt: null,
        ageInDays: null,
        thresholdDays,
        message:
          `⚠ Eval-pipeline staleness guard could not read index: ${errorMessage(err)}`,
      };
    }
  } else {
    const indexPath = getEvalRunsIndexPath();
    if (!existsSync(indexPath)) {
      return {
        status: 'never-run',
        lastRunAt: null,
        ageInDays: null,
        thresholdDays,
        message:
          `⚠ Eval-pipeline has NEVER run: no eval-runs index found at ` +
          `${indexPath}. Run \`afk improve eval-run\` to establish a baseline.`,
      };
    }
    try {
      rawIndex = readFileSync(indexPath, 'utf-8');
    } catch (err) {
      return {
        status: 'error',
        lastRunAt: null,
        ageInDays: null,
        thresholdDays,
        message:
          `⚠ Eval-pipeline staleness guard could not read index: ${errorMessage(err)}`,
      };
    }
  }

  if (rawIndex === null) {
    // Injected reader explicitly returned null — treat as never-run.
    return {
      status: 'never-run',
      lastRunAt: null,
      ageInDays: null,
      thresholdDays,
      message:
        `⚠ Eval-pipeline has NEVER run: eval-runs index is absent. ` +
        `Run \`afk improve eval-run\` to establish a baseline.`,
    };
  }

  let lastRunAt: string | null;
  try {
    lastRunAt = parseLatestTimestamp(rawIndex);
  } catch (err) {
    return {
      status: 'error',
      lastRunAt: null,
      ageInDays: null,
      thresholdDays,
      message:
        `⚠ Eval-pipeline staleness guard encountered a parse error: ${errorMessage(err)}`,
    };
  }

  if (lastRunAt === null) {
    return {
      status: 'never-run',
      lastRunAt: null,
      ageInDays: null,
      thresholdDays,
      message:
        `⚠ Eval-pipeline has NEVER run: eval-runs index exists but contains ` +
        `no timestamp entries. Run \`afk improve eval-run\` to establish a baseline.`,
    };
  }

  const now = (ctx.now ?? (() => new Date()))();
  let lastRunDate: Date;
  try {
    lastRunDate = new Date(lastRunAt);
    if (isNaN(lastRunDate.getTime())) throw new Error(`invalid date: '${lastRunAt}'`);
  } catch (err) {
    return {
      status: 'error',
      lastRunAt,
      ageInDays: null,
      thresholdDays,
      message:
        `⚠ Eval-pipeline staleness guard could not parse last-run timestamp ` +
        `'${lastRunAt}': ${errorMessage(err)}`,
    };
  }

  const ageMs = now.getTime() - lastRunDate.getTime();
  const ageInDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  if (ageInDays >= thresholdDays) {
    return {
      status: 'stale',
      lastRunAt,
      ageInDays,
      thresholdDays,
      message:
        `⚠ Eval-pipeline is STALE: last eval-run was ${ageInDays} day${ageInDays === 1 ? '' : 's'} ago ` +
        `(${lastRunAt}), exceeding the ${thresholdDays}-day threshold ` +
        `(AFK_EVAL_STALENESS_DAYS=${thresholdDays}). ` +
        `Run \`afk improve eval-run\` to check for regressions.`,
    };
  }

  return {
    status: 'fresh',
    lastRunAt,
    ageInDays,
    thresholdDays,
    message:
      `Eval-pipeline is fresh: last eval-run was ${ageInDays} day${ageInDays === 1 ? '' : 's'} ago ` +
      `(${lastRunAt}), within the ${thresholdDays}-day threshold.`,
  };
}
