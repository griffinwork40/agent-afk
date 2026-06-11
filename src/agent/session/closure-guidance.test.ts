/**
 * Tests for the `closure-anomaly` guardrail — {@link buildClosureGuidance}.
 *
 * Pure function: maps a {@link ClosureReason} to an actionable recovery hint
 * (abort subtype) or `null` (benign closes + anomalous reasons not yet
 * covered). The wiring onto the closure trace event is covered in
 * `trace/closure.test.ts`; the eval-run contract is covered in
 * `improve/eval-run/contracts.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { ClosureReason } from '../trace/index.js';
import { buildClosureGuidance, CLOSURE_ABORT_RECOVERY_HINT } from './closure-guidance.js';

describe('buildClosureGuidance', () => {
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

  it('returns null for benign closes — no false-positive guidance', () => {
    expect(buildClosureGuidance('model_end_turn')).toBeNull();
    expect(buildClosureGuidance('truncated')).toBeNull();
  });

  it('returns null for anomalous reasons not yet covered (deferred subtypes)', () => {
    const deferred: ClosureReason[] = [
      'timeout',
      'budget_exceeded',
      'hook_blocked',
      'iteration_cap',
      'max_turns_exceeded',
    ];
    for (const reason of deferred) {
      expect(buildClosureGuidance(reason), `reason=${reason}`).toBeNull();
    }
  });

  it('is pure — repeated calls return the identical value', () => {
    expect(buildClosureGuidance('abort')).toBe(buildClosureGuidance('abort'));
  });
});
