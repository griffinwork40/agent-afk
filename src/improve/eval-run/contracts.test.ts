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
  knownContractIds,
  makeCheck,
  resolveContract,
  snapshot,
  supportedContractPatterns,
} from './contracts.js';
import { REPEAT_CIRCUIT_BREAKER_THRESHOLD } from '../../agent/tools/dispatcher.js';
import { SKILL_MAX_DEPTH_RECOVERY_HINT } from '../../agent/tools/skill-depth-message.js';

// ---------------------------------------------------------------------------
// Registry resolution
// ---------------------------------------------------------------------------

describe('resolveContract', () => {
  it('maps each PR-80 pattern to its contract', () => {
    expect(resolveContract('repeated-tool-use')?.id).toBe('repeat-loop-circuit-breaker');
    expect(resolveContract('subagent-block')?.id).toBe('skill-max-depth-recovery-hint');
    expect(resolveContract('tool-failure-density')?.id).toBe('tool-failure-density-enabled');
  });

  it('returns undefined for a pattern with no deterministic contract', () => {
    expect(resolveContract('closure-anomaly')).toBeUndefined();
  });

  it('supportedContractPatterns / knownContractIds enumerate the registry', () => {
    expect(supportedContractPatterns()).toEqual([
      'repeated-tool-use',
      'subagent-block',
      'tool-failure-density',
    ]);
    expect(knownContractIds()).toEqual([
      'repeat-loop-circuit-breaker',
      'skill-max-depth-recovery-hint',
      'tool-failure-density-enabled',
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
// ---------------------------------------------------------------------------

describe('skill-max-depth-recovery-hint contract', () => {
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
// Contract: tool-failure-density enabled by default
// ---------------------------------------------------------------------------

describe('tool-failure-density-enabled contract', () => {
  it('all checks pass — the detector is enabled by default', async () => {
    const result = await resolveContract('tool-failure-density')!.run();
    expect(result.checks.map((c) => c.name)).toEqual(['in-default-enabled-set', 'not-opt-in']);
    for (const c of result.checks) {
      expect(c.status, `${c.name}: ${c.actual}`).toBe('pass');
    }
    const evidence = result.evidence.find((e) => e.ref.includes('enabledByDefault'));
    expect(evidence?.detail).toBe('true');
  });
});
