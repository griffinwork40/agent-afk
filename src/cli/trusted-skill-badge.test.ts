import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerTrustedSkill,
  getTrustedSkill,
  formatTrustedSkillCompletion,
  formatTrustedSkillInFlight,
  clearRegistryForTesting,
} from './trusted-skill-badge.js';
import { displayWidth } from './display.js';

// The registry is a module-level singleton. Clear it after every test so state
// never leaks across test files or between individual cases in this file.
afterEach(() => {
  clearRegistryForTesting();
});

// Seed the primary test skill before each test so it is available even after
// the afterEach clear from the previous test.
beforeEach(() => {
  registerTrustedSkill('test-badge-1', {
    glyph: '◈',
    color: '#7B5EA7',
    inFlightVerb: 'verifying…',
  });
});

describe('formatTrustedSkillCompletion', () => {
  it('TTY — claims present (partial: claimsTotal + claimsConfirmed only)', () => {
    const result = formatTrustedSkillCompletion(
      { skillName: 'test-badge-1', durationMs: 1200, claimsTotal: 3, claimsConfirmed: 2 },
      { isTTY: true },
    );
    // Should contain skill name, claims, and duration
    expect(result).toContain('test-badge-1');
    expect(result).toContain('3 claims');
    expect(result).toContain('2 confirmed');
    expect(result).toContain('1.2s');
    // TTY path applies color — should NOT be bracket form
    expect(result).not.toMatch(/^\[/);
  });

  it('TTY — all-confirmed shorthand path', () => {
    const result = formatTrustedSkillCompletion(
      { skillName: 'test-badge-1', durationMs: 900, claimsTotal: 3, claimsConfirmed: 3 },
      { isTTY: true },
    );
    expect(result).toContain('3 claims');
    expect(result).toContain('all confirmed');
    expect(result).toContain('0.9s');
    expect(result).not.toContain('confirmed\x1b'); // shouldn't have "confirmed" twice
  });

  it('TTY — duration-only (no claims fields)', () => {
    const result = formatTrustedSkillCompletion(
      { skillName: 'test-badge-1', durationMs: 1500 },
      { isTTY: true },
    );
    expect(result).toContain('test-badge-1');
    expect(result).toContain('1.5s');
    // No claims info
    expect(result).not.toContain('claims');
    expect(result).not.toContain('confirmed');
  });

  it('non-TTY — bracket form with claims', () => {
    const result = formatTrustedSkillCompletion(
      { skillName: 'test-badge-1', durationMs: 1200, claimsTotal: 3, claimsConfirmed: 2 },
      { isTTY: false },
    );
    // Bracket form
    expect(result).toMatch(/^\[/);
    expect(result).toMatch(/]$/);
    expect(result).toContain('test-badge-1');
    expect(result).toContain('2/3 confirmed');
    expect(result).toContain('1.2s');
  });

  it('non-TTY — bracket form duration-only', () => {
    const result = formatTrustedSkillCompletion(
      { skillName: 'test-badge-1', durationMs: 800 },
      { isTTY: false },
    );
    expect(result).toBe('[test-badge-1 · 0.8s]');
  });

  it('unknown skill (not in registry) → graceful bracket fallback', () => {
    const result = formatTrustedSkillCompletion(
      { skillName: 'unknown-xyz-skill', durationMs: 500 },
      { isTTY: true },
    );
    // No glyph, no color, bracket form
    expect(result).toBe('[unknown-xyz-skill · 0.5s]');
  });

  it('width truncation — output ≤ columns display width', () => {
    const result = formatTrustedSkillCompletion(
      {
        skillName: 'test-badge-1',
        durationMs: 1234,
        claimsTotal: 10,
        claimsConfirmed: 8,
        claimsRefuted: 2,
      },
      { isTTY: true, columns: 30 },
    );
    expect(displayWidth(result)).toBeLessThanOrEqual(30);
  });

  it('second skill registration (premise-gate) — correct stamp with ◇ glyph', () => {
    registerTrustedSkill('premise-gate', {
      glyph: '◇',
      color: '#5BA8FF',
      inFlightVerb: 'checking…',
    });
    const result = formatTrustedSkillCompletion(
      { skillName: 'premise-gate', durationMs: 600 },
      { isTTY: true },
    );
    expect(result).toContain('premise-gate');
    expect(result).toContain('0.6s');
    // Entry is in registry
    const entry = getTrustedSkill('premise-gate');
    expect(entry?.glyph).toBe('◇');
    expect(entry?.color).toBe('#5BA8FF');
  });

  it('conflicting re-registration throws', () => {
    registerTrustedSkill('test-conflict-1', {
      glyph: '◈',
      color: '#000000',
      inFlightVerb: 'running…',
    });
    expect(() => {
      registerTrustedSkill('test-conflict-1', {
        glyph: '◇',  // different glyph → conflict
        color: '#000000',
        inFlightVerb: 'running…',
      });
    }).toThrow('already registered with different config');
  });

  it('idempotent same-config re-registration is silent (no throw)', () => {
    registerTrustedSkill('test-idempotent-1', {
      glyph: '◈',
      color: '#AABBCC',
      inFlightVerb: 'verifying…',
    });
    // Same config again — should not throw
    expect(() => {
      registerTrustedSkill('test-idempotent-1', {
        glyph: '◈',
        color: '#AABBCC',
        inFlightVerb: 'verifying…',
      });
    }).not.toThrow();
  });
});

describe('formatTrustedSkillInFlight', () => {
  it('TTY — registered skill includes glyph, name, and verb', () => {
    const result = formatTrustedSkillInFlight('test-badge-1', { isTTY: true });
    expect(result).toContain('◈');
    expect(result).toContain('test-badge-1');
    expect(result).toContain('verifying…');
    // TTY path applies color — should NOT be bracket form
    expect(result).not.toMatch(/^\[/);
  });

  it('non-TTY — bracket form with name + verb', () => {
    const result = formatTrustedSkillInFlight('test-badge-1', { isTTY: false });
    expect(result).toBe('[test-badge-1 · verifying…]');
  });

  it('unknown skill (not in registry) → graceful bracket fallback', () => {
    const result = formatTrustedSkillInFlight('unknown-xyz-skill', { isTTY: true });
    // No glyph, no color, bracket form, generic "running…" verb
    expect(result).toBe('[unknown-xyz-skill · running…]');
  });

  it('width truncation — output ≤ columns display width', () => {
    const result = formatTrustedSkillInFlight('test-badge-1', {
      isTTY: true,
      columns: 12,
    });
    expect(displayWidth(result)).toBeLessThanOrEqual(12);
  });

  it('default opts → TTY path', () => {
    // No opts → isTTY defaults to true
    const result = formatTrustedSkillInFlight('test-badge-1');
    expect(result).toContain('test-badge-1');
    expect(result).toContain('verifying…');
    expect(result).not.toMatch(/^\[/);
  });
});
