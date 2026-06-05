/**
 * Characterization tests for usageLimitBox (src/cli/render/usage-limit-box.ts).
 *
 * Added alongside the drawBox unification: usageLimitBox now delegates to the
 * shared drawBox primitive instead of hand-rolling its border math. These tests
 * pin the visible contract — the yellow ' Usage paused ' chip, the reason-driven
 * body copy (usage-limit vs credit-exhausted), the auto-resume vs manual-retry
 * variants, the reset-time and hot-swap lines, rounded corners + rectangularity
 * — so the delegation can't silently regress.
 *
 * Imports via the `../render.js` barrel to also exercise the index re-export.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { usageLimitBox } from '../render.js';
import { displayWidth } from '../display.js';

/** Strip SGR color codes so shape assertions are chalk-level agnostic. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('usageLimitBox', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('frames with rounded corners and a "Usage paused" chip', () => {
    const rows = strip(usageLimitBox({ reason: 'usage-limit' })).split('\n');
    expect(rows[0]?.startsWith('╭')).toBe(true);
    expect(rows[0]?.endsWith('╮')).toBe(true);
    expect(rows[0]).toContain('Usage paused');
    expect(rows[rows.length - 1]?.startsWith('╰')).toBe(true);
    expect(rows[rows.length - 1]?.endsWith('╯')).toBe(true);
  });

  it('usage-limit reason shows the auto-resume copy by default', () => {
    const out = strip(usageLimitBox({ reason: 'usage-limit' }));
    expect(out).toContain("You've hit your Claude subscription limit");
    expect(out).toContain('auto-resume when the limit resets');
    expect(out).toContain('ANTHROPIC_API_KEY');
  });

  it('autoResume:false swaps in the manual "send the message again" copy', () => {
    const out = strip(usageLimitBox({ reason: 'usage-limit', autoResume: false }));
    expect(out).toContain('Wait, then send the message again');
    expect(out).not.toContain('auto-resume when the limit resets');
  });

  it('shows a reset-time line when resetsAt is provided', () => {
    const resetsAt = new Date(Date.now() + 90 * 60_000);
    const out = strip(usageLimitBox({ reason: 'usage-limit', resetsAt }));
    expect(out).toMatch(/Resets at .+ \(in ~\d+ min\)\./);
  });

  it('credit-exhausted reason shows the billing copy + console URL', () => {
    const out = strip(usageLimitBox({ reason: 'credit-exhausted' }));
    expect(out).toContain('Anthropic API credit balance is empty');
    expect(out).toContain('console.anthropic.com/settings/billing');
  });

  it('appends a "Resumed on" line when hot-swapped', () => {
    const out = strip(
      usageLimitBox({ reason: 'usage-limit', hotSwapped: true, accountId: 'acct-123' }),
    );
    expect(out).toContain('Resumed on acct-123.');
  });

  it('produces a rectangular box (all rows equal display width)', () => {
    const widths = strip(usageLimitBox({ reason: 'usage-limit' }))
      .split('\n')
      .map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
  });

  it('stays rectangular at a narrow terminal (long unbreakable URL truncates)', () => {
    // The billing URL is an unbreakable token wider than the inner width at
    // cols=50; drawBox truncates it with an ellipsis so the box stays
    // rectangular (the prior hand-rolled math let the URL row overflow).
    Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
    const rows = strip(usageLimitBox({ reason: 'credit-exhausted' })).split('\n');
    const widths = rows.map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
  });
});
