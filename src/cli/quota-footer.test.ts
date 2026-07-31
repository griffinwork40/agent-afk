/**
 * Tests for src/cli/quota-footer.ts
 *
 * The footer line is pure and colour-free — the caller maps `tier` → palette
 * role — so every assertion here is on plain text and tier, no ANSI involved.
 */

import { describe, it, expect } from 'vitest';
import { formatQuotaUsage } from './quota-footer.js';
import { TWO_HOURS_MS } from '../agent/providers/anthropic-direct/query/retry-layer.js';

const NOW = new Date('2026-07-29T12:00:00Z');
const inMinutes = (m: number): Date => new Date(NOW.getTime() + m * 60_000);

describe('formatQuotaUsage — silence', () => {
  it('says nothing when no windows are known (API-key auth)', () => {
    expect(formatQuotaUsage(undefined, NOW)).toEqual({ tier: 'quiet', text: null });
    expect(formatQuotaUsage({ observedAt: NOW }, NOW)).toEqual({ tier: 'quiet', text: null });
  });

  it('stays silent through the whole range the ambient indicator already covers', () => {
    // The status-line indicator goes amber at 50%. A printed footer line costs
    // attention every turn, so it must not speak until the cap is a live risk.
    for (const utilization of [0, 0.24, 0.5, 0.62, 0.79]) {
      const r = formatQuotaUsage({ fiveHour: { utilization }, observedAt: NOW }, NOW);
      expect(r).toEqual({ tier: 'quiet', text: null });
    }
  });
});

describe('formatQuotaUsage — tiers', () => {
  const tierAt = (utilization: number) =>
    formatQuotaUsage({ fiveHour: { utilization }, observedAt: NOW }, NOW).tier;

  it('mirrors the context line ladder: 80% caution, 95% near, 100% over', () => {
    expect(tierAt(0.799)).toBe('quiet');
    expect(tierAt(0.8)).toBe('caution');
    expect(tierAt(0.94)).toBe('caution');
    expect(tierAt(0.95)).toBe('near');
    expect(tierAt(0.99)).toBe('near');
    expect(tierAt(1)).toBe('over');
  });

  it('names the window, the percentage, and the deadline at caution', () => {
    const r = formatQuotaUsage(
      { fiveHour: { utilization: 0.84, resetsAt: inMinutes(80) }, observedAt: NOW },
      NOW,
    );
    expect(r.tier).toBe('caution');
    expect(r.text).toBe('  5h quota 84% used — resets in 1h20m');
  });

  it('adds the park-and-resume reassurance once a cap is imminent', () => {
    // The runtime really does park and resume on a usage-limit 429, so the line
    // should say so — an alarming number with no next step is worse than useless.
    const near = formatQuotaUsage(
      { fiveHour: { utilization: 0.96, resetsAt: inMinutes(12) }, observedAt: NOW },
      NOW,
    );
    expect(near.tier).toBe('near');
    expect(near.text).toBe('  5h quota 96% used — resets in 12m — AFK pauses and auto-resumes at the cap');
  });

  it('reports exhaustion without a percentage — 100% needs no number', () => {
    const over = formatQuotaUsage(
      { fiveHour: { utilization: 1, resetsAt: inMinutes(12) }, observedAt: NOW },
      NOW,
    );
    expect(over.tier).toBe('over');
    expect(over.text).toBe('  5h quota exhausted — resets in 12m — AFK pauses and auto-resumes at the cap');
  });
});

describe('formatQuotaUsage — window selection', () => {
  it('reports the binding window, not the first one', () => {
    const r = formatQuotaUsage(
      {
        fiveHour: { utilization: 0.4, resetsAt: inMinutes(200) },
        sevenDay: { utilization: 0.88, resetsAt: inMinutes(3300) },
        observedAt: NOW,
      },
      NOW,
    );
    expect(r.text).toBe('  7d quota 88% used — resets in 2d7h');
  });

  it('appends the other window only when it is ALSO hot', () => {
    // Otherwise a hot 5h line would imply the 7d budget is fine when it is at 99%.
    const bothHot = formatQuotaUsage(
      {
        fiveHour: { utilization: 0.97, resetsAt: inMinutes(12) },
        sevenDay: { utilization: 0.86, resetsAt: inMinutes(3300) },
        observedAt: NOW,
      },
      NOW,
    );
    expect(bothHot.text).toContain('(also 7d 86%)');

    const oneHot = formatQuotaUsage(
      {
        fiveHour: { utilization: 0.97, resetsAt: inMinutes(12) },
        sevenDay: { utilization: 0.24, resetsAt: inMinutes(3300) },
        observedAt: NOW,
      },
      NOW,
    );
    expect(oneHot.text).not.toContain('also');
  });
});

describe('formatQuotaUsage — deadline handling', () => {
  it('omits the reset clause when the header carried no deadline', () => {
    const r = formatQuotaUsage({ fiveHour: { utilization: 0.84 }, observedAt: NOW }, NOW);
    expect(r.text).toBe('  5h quota 84% used');
    expect(r.text).not.toContain('resets');
  });

  it('omits an already-elapsed deadline rather than asserting a passed reset', () => {
    const r = formatQuotaUsage(
      { fiveHour: { utilization: 0.84, resetsAt: inMinutes(-5) }, observedAt: NOW },
      NOW,
    );
    expect(r.text).toBe('  5h quota 84% used');
  });

  it('still reassures at the cap when no deadline is known', () => {
    const r = formatQuotaUsage({ fiveHour: { utilization: 1 }, observedAt: NOW }, NOW);
    expect(r.text).toBe('  5h quota exhausted — AFK pauses and auto-resumes at the cap');
  });
});

describe('formatQuotaUsage — shape', () => {
  it('indents by two spaces like every other footer line', () => {
    const r = formatQuotaUsage({ fiveHour: { utilization: 0.84 }, observedAt: NOW }, NOW);
    expect(r.text?.startsWith('  ')).toBe(true);
    expect(r.text?.startsWith('   ')).toBe(false);
  });

  it('emits no ANSI — the caller owns the tone', () => {
    const r = formatQuotaUsage({ fiveHour: { utilization: 1 }, observedAt: NOW }, NOW);
    // eslint-disable-next-line no-control-regex
    expect(r.text).not.toMatch(/\u001b\[/);
  });
});

describe('formatQuotaUsage — the auto-resume promise', () => {
  const hot = (resetsAt?: Date): Parameters<typeof formatQuotaUsage>[0] => ({
    fiveHour: { utilization: 0.97, ...(resetsAt !== undefined ? { resetsAt } : {}) },
    observedAt: NOW,
  });

  it('withholds the promise when auto-resume is switched off', () => {
    const r = formatQuotaUsage(hot(inMinutes(12)), NOW, { autoResume: false });
    expect(r.text).not.toContain('auto-resumes');
    expect(r.text).toBe('  5h quota 97% used — resets in 12m — turns stop at the cap — auto-resume is off');
  });

  it('withholds the promise when the reset is beyond the wait ceiling', () => {
    // A hot 7d window routinely resets days out. The retry layer surfaces the
    // error rather than waiting that long, so a resume promise would be a lie
    // that walks an AFK user away from a turn which is about to terminate.
    const r = formatQuotaUsage(
      { sevenDay: { utilization: 0.97, resetsAt: inMinutes(3 * 60) }, observedAt: NOW },
      NOW,
    );
    expect(r.text).not.toContain('auto-resumes');
    expect(r.text).toContain('too far out to wait');
  });

  it('tracks the retry layer\u2019s real ceiling rather than a drifted copy', () => {
    // Drift guard. quota-footer.ts holds a LOCAL copy of the threshold so the
    // provider graph stays out of the render path; these boundary assertions
    // are what make that copy safe — move TWO_HOURS_MS in retry-layer.ts and
    // this fails instead of the copy going quietly stale.
    const atCeiling = formatQuotaUsage(hot(new Date(NOW.getTime() + TWO_HOURS_MS)), NOW);
    expect(atCeiling.text).toContain('AFK pauses and auto-resumes at the cap');
    const pastCeiling = formatQuotaUsage(hot(new Date(NOW.getTime() + TWO_HOURS_MS + 60_000)), NOW);
    expect(pastCeiling.text).toContain('too far out to wait');
  });

  it('keeps the promise when no deadline is known — the layer still parks', () => {
    expect(formatQuotaUsage(hot(), NOW).text).toContain('AFK pauses and auto-resumes at the cap');
  });

  it('promises by default, matching the provider\u2019s own default', () => {
    expect(formatQuotaUsage(hot(inMinutes(12)), NOW).text).toContain('auto-resumes');
  });
});
