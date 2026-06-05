import { describe, it, expect } from 'vitest';
import { TrustedSkillLedger } from './trusted-skill-ledger.js';

describe('TrustedSkillLedger', () => {
  it('summary() returns null on fresh instance', () => {
    const ledger = new TrustedSkillLedger();
    expect(ledger.summary()).toBeNull();
  });

  it('record() + summary() accumulates single skill entry', () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({ skillName: 'test-skill', durationMs: 1200 });
    const summary = ledger.summary();
    expect(summary).not.toBeNull();
    const entry = summary!.get('test-skill');
    expect(entry).toBeDefined();
    expect(entry!.runs).toBe(1);
    expect(entry!.totalDurationMs).toBe(1200);
  });

  it('record() called twice for same skill sums correctly', () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({ skillName: 'test-skill', durationMs: 1000 });
    ledger.record({ skillName: 'test-skill', durationMs: 2000 });
    const summary = ledger.summary();
    const entry = summary!.get('test-skill');
    expect(entry!.runs).toBe(2);
    expect(entry!.totalDurationMs).toBe(3000);
  });

  it('record() with claims fields — confirms/refutes aggregate', () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({
      skillName: 'test-skill',
      durationMs: 1000,
      claimsTotal: 3,
      claimsConfirmed: 2,
      claimsRefuted: 1,
    });
    ledger.record({
      skillName: 'test-skill',
      durationMs: 2000,
      claimsTotal: 4,
      claimsConfirmed: 3,
      claimsRefuted: 1,
    });
    const entry = ledger.summary()!.get('test-skill')!;
    expect(entry.runs).toBe(2);
    expect(entry.totalClaims).toBe(7);
    expect(entry.totalConfirmed).toBe(5);
    expect(entry.totalRefuted).toBe(2);
  });

  it('record() for two different skills produces two-entry summary', () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({ skillName: 'skill-a', durationMs: 500 });
    ledger.record({ skillName: 'skill-b', durationMs: 800 });
    const summary = ledger.summary();
    expect(summary!.size).toBe(2);
    expect(summary!.has('skill-a')).toBe(true);
    expect(summary!.has('skill-b')).toBe(true);
  });

  it('clear() resets to null', () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({ skillName: 'test-skill', durationMs: 1000 });
    expect(ledger.summary()).not.toBeNull();
    ledger.clear();
    expect(ledger.summary()).toBeNull();
  });

  it('two independently constructed instances share no state', () => {
    const ledgerA = new TrustedSkillLedger();
    const ledgerB = new TrustedSkillLedger();
    ledgerA.record({ skillName: 'test-skill', durationMs: 1000 });
    expect(ledgerA.summary()).not.toBeNull();
    expect(ledgerB.summary()).toBeNull();
  });

  it('record() with duration-only (no claims) — summary entry has no totalClaims', () => {
    const ledger = new TrustedSkillLedger();
    ledger.record({ skillName: 'test-skill', durationMs: 1500 });
    const entry = ledger.summary()!.get('test-skill')!;
    expect(entry.totalClaims).toBeUndefined();
    expect(entry.totalConfirmed).toBeUndefined();
    expect(entry.totalRefuted).toBeUndefined();
  });
});
