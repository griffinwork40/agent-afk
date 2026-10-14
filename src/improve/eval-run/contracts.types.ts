/**
 * Shared types and utility functions for eval-run contracts.
 *
 * Extracted so {@link ./contracts} and {@link ./contracts.tfd} can both
 * import from here without a circular dependency.
 *
 * @module improve/eval-run/contracts.types
 */

import type { EvalCheck, EvalCheckStatus, EvalRunEvidenceRef, FailurePattern } from '../schemas.js';

// ---------------------------------------------------------------------------
// Shared surface types
// ---------------------------------------------------------------------------

export interface ContractProbeResult {
  checks: EvalCheck[];
  evidence: EvalRunEvidenceRef[];
}

export interface EvalContract {
  /** Stable id, written to the eval-run's `contract` field. */
  id: string;
  /** The pattern whose guardrail this contract validates. */
  patternId: FailurePattern;
  /** One-line human description. */
  title: string;
  /** Run the deterministic probe. Pure modulo throwaway in-memory objects. */
  run: () => Promise<ContractProbeResult>;
}

// ---------------------------------------------------------------------------
// Snapshot helper
// ---------------------------------------------------------------------------

/** Cap on `expected`/`actual`/`detail` snapshots so artifacts stay readable. */
const SNAPSHOT_MAX = 400;

/** Trim a value for an artifact snapshot — single line, bounded length. */
export function snapshot(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > SNAPSHOT_MAX ? oneLine.slice(0, SNAPSHOT_MAX - 1) + '\u2026' : oneLine;
}

/** Build a check record. `pass` is the boolean the assertion evaluated to. */
export function makeCheck(args: {
  name: string;
  description: string;
  pass: boolean;
  expected: string;
  actual: string;
  /** Force a non-pass/fail status (e.g. `'skipped'`). Overrides `pass`. */
  status?: EvalCheckStatus;
}): EvalCheck {
  return {
    name: args.name,
    description: args.description,
    status: args.status ?? (args.pass ? 'pass' : 'fail'),
    expected: snapshot(args.expected),
    actual: snapshot(args.actual),
  };
}
