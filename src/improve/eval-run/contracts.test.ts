/**
 * Tests for `improve/eval-run/contracts.ts`.
 *
 * These exercise the REAL guardrails (the live dispatcher, the live skill
 * depth-message builder, the live detector registry) — so a regression in any
 * guardrail surfaces here as a failing check, exactly as it would in a real
 * `afk improve eval-run`. No disk I/O, no AFK_HOME isolation needed.
 */

import { describe, expect, it } from 'vitest';
import {
  buildToolFailureClassificationCorpus,
  knownContractIds,
  makeCheck,
  resolveContract,
  snapshot,
  supportedContractPatterns,
} from './contracts.js';
import { REPEAT_CIRCUIT_BREAKER_THRESHOLD } from '../../agent/tools/dispatcher.js';
import { SKILL_MAX_DEPTH_RECOVERY_HINT } from '../../agent/tools/skill-depth-message.js';
import { detectToolFailureDensity } from '../scan/detectors/tool-failure-density.js';
import type { FailurePattern } from '../schemas.js';

// ---------------------------------------------------------------------------
// Registry resolution
// ---------------------------------------------------------------------------

describe('resolveContract', () => {
  it('maps each registered pattern to its contract', () => {
    expect(resolveContract('repeated-tool-use')?.id).toBe('repeat-loop-circuit-breaker');
    expect(resolveContract('subagent-block')?.id).toBe('skill-max-depth-recovery-hint');
    expect(resolveContract('tool-failure-density')?.id).toBe('tool-failure-density-enabled');
    expect(resolveContract('closure-anomaly')?.id).toBe('closure-abort-recovery-hint');
  });

  it('returns undefined for an unregistered (future) pattern', () => {
    // Every current FailurePattern now has a contract; a future pattern with
    // none resolves to undefined → the runner records an `unsupported` result.
    expect(resolveContract('abort-cascade' as FailurePattern)).toBeUndefined();
  });

  it('supportedContractPatterns / knownContractIds enumerate the registry', () => {
    expect(supportedContractPatterns()).toEqual([
      'repeated-tool-use',
      'subagent-block',
      'tool-failure-density',
      'closure-anomaly',
    ]);
    expect(knownContractIds()).toEqual([
      'repeat-loop-circuit-breaker',
      'skill-max-depth-recovery-hint',
      'tool-failure-density-enabled',
      'closure-abort-recovery-hint',
    ]);
  });
});

// ---------------------------------------------------------------------------
// makeCheck / snapshot helpers
// ---------------------------------------------------------------------------

describe('makeCheck / snapshot', () => {
  it('derives pass/fail status from the boolean', () => {
    expect(makeCheck({ name: 'a', description: 'd', pass: true, expected: 'x', actual: 'x' }).status).toBe('pass');
    expect(makeCheck({ name: 'a', description: 'd', pass: false, expected: 'x', actual: 'y' }).status).toBe('fail');
  });

  it('honours an explicit status override', () => {
    const c = makeCheck({ name: 'a', description: 'd', pass: true, expected: '', actual: '', status: 'skipped' });
    expect(c.status).toBe('skipped');
  });

  it('snapshot collapses whitespace and bounds length', () => {
    expect(snapshot('a\n  b\t c')).toBe('a b c');
    const long = 'x'.repeat(1000);
    const s = snapshot(long);
    expect(s.length).toBeLessThanOrEqual(400);
    expect(s.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contract: repeat-loop circuit breaker (exercises the real dispatcher)
// ---------------------------------------------------------------------------

describe('repeat-loop-circuit-breaker contract', () => {
  it('all checks pass against the live circuit breaker', async () => {
    const contract = resolveContract('repeated-tool-use');
    expect(contract).toBeDefined();
    const result = await contract!.run();

    expect(result.checks).toHaveLength(4);
    for (const c of result.checks) {
      expect(c.status, `${c.name}: expected=${c.expected} actual=${c.actual}`).toBe('pass');
    }

    const names = result.checks.map((c) => c.name);
    expect(names).toEqual([
      'executes-below-threshold',
      'trips-at-threshold',
      'breaker-message-is-actionable',
      'resets-on-different-input',
    ]);
  });

  it('records the live threshold as evidence', async () => {
    const result = await resolveContract('repeated-tool-use')!.run();
    const thresholdEvidence = result.evidence.find((e) =>
      e.ref.includes('REPEAT_CIRCUIT_BREAKER_THRESHOLD'),
    );
    expect(thresholdEvidence?.detail).toBe(String(REPEAT_CIRCUIT_BREAKER_THRESHOLD));
  });
});

// ---------------------------------------------------------------------------
// Contract: skill max-depth recovery hint
//
// KNOWN MISMAPPING: this contract is registered under patternId
// `subagent-block`, but it validates the skill MAX-DEPTH refusal — a different
// mechanism than the `hook_decision`/SubagentStart/`block` events the
// subagent-block detector actually fires on (see the note in contracts.ts).
// The checks below still pass (the refusal builder is healthy); they just do
// not prove anything about the detector's recorded failures. Do NOT add a
// fixture-replay for subagent-block against this contract until the mapping is
// resolved.
// ---------------------------------------------------------------------------

describe('skill-max-depth-recovery-hint contract (KNOWN subagent-block mismapping)', () => {
  it('all checks pass against the live refusal builder', async () => {
    const result = await resolveContract('subagent-block')!.run();
    expect(result.checks.map((c) => c.name)).toEqual([
      'refusal-states-depth',
      'recovery-hint-present',
      'hint-directs-inline-work',
    ]);
    for (const c of result.checks) {
      expect(c.status, `${c.name}: ${c.actual}`).toBe('pass');
    }
  });

  it('evidence references the shared message builder and carries the hint', async () => {
    const result = await resolveContract('subagent-block')!.run();
    const builderEvidence = result.evidence.find((e) => e.ref.includes('buildSkillMaxDepthRefusal'));
    expect(builderEvidence).toBeDefined();
    expect(builderEvidence!.detail).toContain(SKILL_MAX_DEPTH_RECOVERY_HINT);
  });
});

// ---------------------------------------------------------------------------
// Contract: tool-failure-density enabled by default + classification fidelity
// ---------------------------------------------------------------------------

describe('tool-failure-density-enabled contract', () => {
  it('all checks pass — enabled-by-default presence + classification fidelity', async () => {
    const result = await resolveContract('tool-failure-density')!.run();
    expect(result.checks.map((c) => c.name)).toEqual([
      'in-default-enabled-set',
      'not-opt-in',
      'classification-fires-on-dual-threshold',
      'classification-excludes-system-said-no-classes',
      'classification-excludes-circuit-breaker',
      'classification-counts-timeout-and-unclassified',
      'classification-respects-thresholds',
      'classification-reports-affected-sessions-and-seqs',
    ]);
    for (const c of result.checks) {
      expect(c.status, `${c.name}: ${c.actual}`).toBe('pass');
    }
    const evidence = result.evidence.find((e) => e.ref.includes('enabledByDefault'));
    expect(evidence?.detail).toBe('true');
  });

  it('classification probe records the live detector as evidence', async () => {
    const result = await resolveContract('tool-failure-density')!.run();
    const detectorEvidence = result.evidence.find((e) => e.ref.includes('detectToolFailureDensity'));
    expect(detectorEvidence).toBeDefined();
    expect(detectorEvidence!.detail).toContain('flaky_tool');
  });
});

// ---------------------------------------------------------------------------
// Classification: detectToolFailureDensity over the synthetic SessionRead corpus
//
// These feed the SAME synthetic corpus the contract probe uses directly through
// the live detector and assert the classification math at field granularity —
// the regression surface the contract's pass/fail checks summarise.
// ---------------------------------------------------------------------------

describe('tool-failure-density classification (synthetic SessionRead corpus)', () => {
  const cards = detectToolFailureDensity(buildToolFailureClassificationCorpus(), {});
  const flaky = cards.find((c) => c.slug === 'tool-failure-flaky-tool');

  it('emits exactly one card — the tool that clears BOTH thresholds', () => {
    expect(cards.map((c) => c.slug)).toEqual(['tool-failure-flaky-tool']);
    expect(flaky).toBeDefined();
  });

  it('excludes system-said-no classes from numerator AND denominator', () => {
    // 3 counted failures (timeout + 2 unclassified) over 5 counted calls.
    expect(flaky!.detail['failureCount']).toBe(3);
    expect(flaky!.detail['totalCalls']).toBe(5);
    expect(flaky!.detail['failureRate']).toBe(0.6);
    expect(flaky!.detail['excludedByClass']).toEqual({
      'policy-refusal': 1,
      'permission-denied': 1,
      abort: 1,
      'hook-block': 1,
      'elicitation-declined': 1,
    });
  });

  it('never manufactures a card from excluded classes alone', () => {
    // refusal_only_tool has 5 isError results, ALL excluded classes (a raw 5/6
    // error rate that would fire if the exclusion regressed) + 1 success.
    expect(cards.find((c) => c.slug === 'tool-failure-refusal-only-tool')).toBeUndefined();
  });

  it('excludes circuitBreaker-synthesised completions before classification', () => {
    // The breaker event (isError, no class) would push totalCalls→6 and
    // unclassified→3 if counted; it is skipped, and never lands in excludedByClass.
    expect(flaky!.detail['totalCalls']).toBe(5);
    expect(flaky!.detail['failureClassBreakdown']).toEqual({ timeout: 1, unclassified: 2 });
    expect(Object.keys(flaky!.detail['excludedByClass'] as Record<string, number>)).not.toContain(
      'circuitBreaker',
    );
  });

  it('counts timeout and unclassified real tool failures', () => {
    expect(flaky!.detail['failureClassBreakdown']).toEqual({ timeout: 1, unclassified: 2 });
  });

  it('respects the dual count+rate threshold (both must clear)', () => {
    const corpus = buildToolFailureClassificationCorpus();
    // Count gate: raise the failure floor above the recorded 3 → card drops out.
    expect(
      detectToolFailureDensity(corpus, { minFailures: 4 }).map((c) => c.slug),
    ).not.toContain('tool-failure-flaky-tool');
    // Rate gate: raise the rate floor above the recorded 0.6 → card drops out.
    expect(
      detectToolFailureDensity(corpus, { minFailureRate: 0.7 }).map((c) => c.slug),
    ).not.toContain('tool-failure-flaky-tool');
  });

  it('reports affected sessions and per-failure seqs deterministically', () => {
    expect(flaky!.detail['affectedSessionCount']).toBe(2);
    expect([...(flaky!.detail['sessionIds'] as string[])].sort()).toEqual([
      'tfd-sess-a',
      'tfd-sess-b',
    ]);
    // Failure seqs in iteration order: sess-a seq1, sess-a seq2, sess-b seq0.
    expect(flaky!.detail['seqs']).toEqual([1, 2, 0]);
  });
});

// ---------------------------------------------------------------------------
// Contract: closure-anomaly abort recovery hint
// ---------------------------------------------------------------------------

describe('closure-abort-recovery-hint contract', () => {
  it('all checks pass against the live closure guardrail', async () => {
    const result = await resolveContract('closure-anomaly')!.run();
    expect(result.checks.map((c) => c.name)).toEqual([
      'abort-closure-has-guidance',
      'guidance-names-a-recovery-action',
      'guidance-is-the-canonical-constant',
      'benign-closure-has-no-guidance',
    ]);
    for (const c of result.checks) {
      expect(c.status, `${c.name}: ${c.actual}`).toBe('pass');
    }
  });

  it('evidence references the real guardrail builder', async () => {
    const result = await resolveContract('closure-anomaly')!.run();
    const builderEvidence = result.evidence.find((e) => e.ref.includes('buildClosureGuidance'));
    expect(builderEvidence).toBeDefined();
    expect(builderEvidence!.detail).toContain('afk --resume');
  });
});
