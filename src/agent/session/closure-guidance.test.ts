/**
 * Tests for the `closure-anomaly` guardrail — {@link buildClosureGuidance}.
 *
 * Pure function: maps a {@link ClosureReason} to an actionable recovery hint
 * (abort, iteration_cap, timeout subtypes) or `null` (benign closes +
 * anomalous reasons not yet covered). The wiring onto the closure trace event
 * is covered in `trace/closure.test.ts`; the eval-run contract is covered in
 * `improve/eval-run/contracts.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { ClosureReason } from '../trace/index.js';
import {
  buildClosureGuidance,
  CLOSURE_ABORT_RECOVERY_HINT,
  CLOSURE_ITERATION_CAP_RECOVERY_HINT,
  CLOSURE_TIMEOUT_RECOVERY_HINT,
} from './closure-guidance.js';

describe('buildClosureGuidance', () => {
  // -- abort --
  it('returns the canonical recovery hint for an abort closure', () => {
    expect(buildClosureGuidance('abort')).toBe(CLOSURE_ABORT_RECOVERY_HINT);
    expect(CLOSURE_ABORT_RECOVERY_HINT.trim().length).toBeGreaterThan(0);
  });

  it('the abort hint names a concrete recovery action', () => {
    expect(buildClosureGuidance('abort')).toMatch(/\b(resume|re-run|rerun|retry)\b/i);
  });

  it('the abort hint points at the real recovery command (afk --resume)', () => {
    expect(CLOSURE_ABORT_RECOVERY_HINT).toMatch(/afk --resume/);
  });

  // -- iteration_cap --
  it('returns the canonical recovery hint for an iteration_cap closure', () => {
    expect(buildClosureGuidance('iteration_cap')).toBe(CLOSURE_ITERATION_CAP_RECOVERY_HINT);
    expect(CLOSURE_ITERATION_CAP_RECOVERY_HINT.trim().length).toBeGreaterThan(0);
  });

  it('the iteration_cap hint names a concrete recovery action', () => {
    expect(buildClosureGuidance('iteration_cap')).toMatch(/\b(resume|re-run|rerun|retry)\b/i);
  });

  it('the iteration_cap hint mentions the budget lever', () => {
    expect(CLOSURE_ITERATION_CAP_RECOVERY_HINT).toMatch(/max.turns|max_tool_use_iterations/i);
  });

  // -- timeout --
  it('returns the canonical recovery hint for a timeout closure', () => {
    expect(buildClosureGuidance('timeout')).toBe(CLOSURE_TIMEOUT_RECOVERY_HINT);
    expect(CLOSURE_TIMEOUT_RECOVERY_HINT.trim().length).toBeGreaterThan(0);
  });

  it('the timeout hint names a concrete recovery action', () => {
    expect(buildClosureGuidance('timeout')).toMatch(/\b(resume|re-run|rerun|retry)\b/i);
  });

  it('the timeout hint mentions checking what was slow', () => {
    expect(CLOSURE_TIMEOUT_RECOVERY_HINT).toMatch(/trace|slow tool/i);
  });

  // -- benign --
  it('returns null for benign closes — no false-positive guidance', () => {
    expect(buildClosureGuidance('model_end_turn')).toBeNull();
    expect(buildClosureGuidance('truncated')).toBeNull();
  });

  // -- deferred anomalous subtypes --
  it('returns null for anomalous reasons not yet covered (deferred subtypes)', () => {
    const deferred: ClosureReason[] = [
      'budget_exceeded',
      'hook_blocked',
      'max_turns_exceeded',
    ];
    for (const reason of deferred) {
      expect(buildClosureGuidance(reason), `reason=${reason}`).toBeNull();
    }
  });

  // -- purity --
  it('is pure — repeated calls return the identical value', () => {
    expect(buildClosureGuidance('abort')).toBe(buildClosureGuidance('abort'));
    expect(buildClosureGuidance('iteration_cap')).toBe(buildClosureGuidance('iteration_cap'));
    expect(buildClosureGuidance('timeout')).toBe(buildClosureGuidance('timeout'));
  });
});
