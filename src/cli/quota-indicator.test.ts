/**
 * Tests for src/cli/quota-indicator.ts
 *
 * Assertions run against ANSI-stripped text for layout and against
 * `palette.<role>`-wrapped substrings for tone, so a palette retune breaks
 * nothing while a tone REGRESSION (e.g. a critical window rendering in the calm
 * chrome tone) still fails.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import chalk from 'chalk';
import { formatQuotaIndicator, formatResetCountdown, STALE_AFTER_MS } from './quota-indicator.js';
import { palette } from './palette.js';
import { displayWidth, stripAnsi } from './display.js';

// Invariant: vitest runs non-TTY, so `color-config.ts` pins `chalk.level = 0`
// and EVERY palette role collapses to bare text — which makes a tone assertion
// vacuously true and its negation vacuously false. Force truecolor for this file
// so the tone tests below actually discriminate `error` from `chrome`. Safe to
// mutate globally: palette builders read `chalk.level` at call time (see the
// theming invariant in palette.ts).
let priorChalkLevel: typeof chalk.level;
beforeAll(() => {
  priorChalkLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = priorChalkLevel;
});

const NOW = new Date('2026-07-29T12:00:00Z');
const inMinutes = (m: number): Date => new Date(NOW.getTime() + m * 60_000);

describe('formatQuotaIndicator — presence', () => {
  it('returns undefined when neither window is known (API-key auth)', () => {
    expect(formatQuotaIndicator({}, NOW)).toBeUndefined();
    expect(formatQuotaIndicator({ observedAt: NOW }, NOW)).toBeUndefined();
  });

  it('renders a single window when only one is known', () => {
    const only5h = formatQuotaIndicator({ fiveHour: { utilization: 0.05 }, observedAt: NOW }, NOW);
    expect(stripAnsi(only5h!.text)).toBe('5h ▁5%');
    const only7d = formatQuotaIndicator({ sevenDay: { utilization: 0.5 }, observedAt: NOW }, NOW);
    expect(stripAnsi(only7d!.text)).toBe('7d ▅50%');
  });

  it('treats utilization as a 0..1 fraction and rounds to a whole percent', () => {
    // Units regression guard: 0.626 must be 63% — not 0%, not 6200%.
    const r = formatQuotaIndicator({ fiveHour: { utilization: 0.626 }, observedAt: NOW }, NOW);
    const text = stripAnsi(r!.text);
    expect(text).toContain('63%');
    expect(text).not.toContain('6200');
  });
});

describe('formatQuotaIndicator — severity', () => {
  it('is calm at or below 50%, caution above 50%, critical above 80%', () => {
    const at = (u: number) => formatQuotaIndicator({ fiveHour: { utilization: u }, observedAt: NOW }, NOW)!.severity;
    expect(at(0)).toBe('calm');
    expect(at(0.5)).toBe('calm'); // boundary is exclusive, matching context-bar
    expect(at(0.51)).toBe('caution');
    expect(at(0.8)).toBe('caution');
    expect(at(0.81)).toBe('critical');
    expect(at(1)).toBe('critical');
  });

  it('reports the WORST window, so a hot 7d escalates a calm 5h row', () => {
    const r = formatQuotaIndicator(
      { fiveHour: { utilization: 0.1 }, sevenDay: { utilization: 0.88 }, observedAt: NOW },
      NOW,
    );
    expect(r!.severity).toBe('critical');
  });

  it('tones each window independently — a red 5h must not drag 7d red with it', () => {
    const r = formatQuotaIndicator(
      { fiveHour: { utilization: 0.94 }, sevenDay: { utilization: 0.24 }, observedAt: NOW },
      NOW,
    );
    expect(r!.text).toContain(palette.error('█94%'));
    expect(r!.text).toContain(palette.chrome('▂24%'));
  });

  it('uses the caution tone in the middle band', () => {
    const r = formatQuotaIndicator({ fiveHour: { utilization: 0.62 }, observedAt: NOW }, NOW);
    expect(r!.text).toContain(palette.warning('▅62%'));
  });

  it('keeps a calm window in chrome, not the near-invisible meta tone', () => {
    // Guard against re-making the context bar's original mistake: a fully
    // recessive readout reads as broken rather than reassuring.
    const r = formatQuotaIndicator({ fiveHour: { utilization: 0.06 }, observedAt: NOW }, NOW);
    expect(r!.text).toContain(palette.chrome('▁6%'));
    expect(r!.text).not.toContain(palette.meta('▁6%'));
  });
});

describe('formatQuotaIndicator — gauge glyph (non-colour encoding)', () => {
  it('scales the block cell with utilization and never renders an empty cell', () => {
    const cellAt = (u: number) =>
      stripAnsi(formatQuotaIndicator({ fiveHour: { utilization: u }, observedAt: NOW }, NOW)!.text).slice(3, 4);
    expect(cellAt(0)).toBe('▁'); // floor cell, so the field is never blank
    expect(cellAt(0.24)).toBe('▂');
    expect(cellAt(0.62)).toBe('▅');
    expect(cellAt(0.94)).toBe('█');
    expect(cellAt(1)).toBe('█'); // top cell, not an out-of-range read
  });

  it('survives colour stripping — the glyph carries the signal under NO_COLOR', () => {
    const hot = stripAnsi(formatQuotaIndicator({ fiveHour: { utilization: 0.94 }, observedAt: NOW }, NOW)!.text);
    const cold = stripAnsi(formatQuotaIndicator({ fiveHour: { utilization: 0.06 }, observedAt: NOW }, NOW)!.text);
    expect(hot).not.toBe(cold);
    expect(hot).toContain('█');
    expect(cold).toContain('▁');
  });
});

describe('formatQuotaIndicator — reset countdown', () => {
  it('is omitted entirely while the row is calm', () => {
    const r = formatQuotaIndicator(
      { fiveHour: { utilization: 0.1, resetsAt: inMinutes(30) }, observedAt: NOW },
      NOW,
    );
    expect(stripAnsi(r!.text)).toBe('5h ▁10%');
  });

  it('attaches to the BINDING window only, never both', () => {
    const r = formatQuotaIndicator(
      {
        fiveHour: { utilization: 0.94, resetsAt: inMinutes(12) },
        sevenDay: { utilization: 0.24, resetsAt: inMinutes(5000) },
        observedAt: NOW,
      },
      NOW,
    );
    expect(stripAnsi(r!.text)).toBe('5h █94% ⟳12m · 7d ▂24%');
  });

  it('follows the binding window when 7d is the hotter one', () => {
    const r = formatQuotaIndicator(
      {
        fiveHour: { utilization: 0.4, resetsAt: inMinutes(200) },
        sevenDay: { utilization: 0.88, resetsAt: inMinutes(3300) },
        observedAt: NOW,
      },
      NOW,
    );
    expect(stripAnsi(r!.text)).toBe('5h ▄40% · 7d █88% ⟳2d7h');
  });

  it('separates two identical percentages by their deadlines', () => {
    // The whole point of the countdown: 94% with 12m left and 94% with 4h left
    // are opposite situations that the bare-percentage segment rendered alike.
    const soon = formatQuotaIndicator(
      { fiveHour: { utilization: 0.94, resetsAt: inMinutes(12) }, observedAt: NOW },
      NOW,
    );
    const later = formatQuotaIndicator(
      { fiveHour: { utilization: 0.94, resetsAt: inMinutes(247) }, observedAt: NOW },
      NOW,
    );
    expect(stripAnsi(soon!.text)).not.toBe(stripAnsi(later!.text));
    expect(stripAnsi(soon!.text)).toContain('⟳12m');
    expect(stripAnsi(later!.text)).toContain('⟳4h7m');
  });

  it('omits the countdown when the header carried no deadline', () => {
    const r = formatQuotaIndicator({ fiveHour: { utilization: 0.94 }, observedAt: NOW }, NOW);
    expect(stripAnsi(r!.text)).toBe('5h █94%');
  });

  it('omits an already-elapsed deadline rather than asserting a passed reset', () => {
    const r = formatQuotaIndicator(
      { fiveHour: { utilization: 0.94, resetsAt: inMinutes(-5) }, observedAt: NOW },
      NOW,
    );
    expect(stripAnsi(r!.text)).toBe('5h █94%');
    expect(stripAnsi(r!.text)).not.toContain('⟳');
  });

  it('keeps the countdown recessive so the percentage stays the focal point', () => {
    const r = formatQuotaIndicator(
      { fiveHour: { utilization: 0.94, resetsAt: inMinutes(12) }, observedAt: NOW },
      NOW,
    );
    expect(r!.text).toContain(palette.meta('⟳12m'));
  });
});

describe('formatQuotaIndicator — staleness', () => {
  it('is fresh at the threshold and stale past it', () => {
    const windows = (ageMs: number) => ({
      fiveHour: { utilization: 0.94 },
      observedAt: new Date(NOW.getTime() - ageMs),
    });
    expect(formatQuotaIndicator(windows(STALE_AFTER_MS), NOW)!.stale).toBe(false);
    expect(formatQuotaIndicator(windows(STALE_AFTER_MS + 1), NOW)!.stale).toBe(true);
  });

  it('marks a stale reading with a leading ~ but still shows the number', () => {
    const r = formatQuotaIndicator(
      {
        fiveHour: { utilization: 0.94, resetsAt: inMinutes(12) },
        observedAt: new Date(NOW.getTime() - 40 * 60_000),
      },
      NOW,
    );
    expect(stripAnsi(r!.text)).toBe('~5h █94% ⟳12m');
    expect(r!.severity).toBe('critical'); // tone is unchanged: stale-high is pessimistic, not wrong
  });

  it('is never stale when the cache reported no observation time', () => {
    expect(formatQuotaIndicator({ fiveHour: { utilization: 0.94 } }, NOW)!.stale).toBe(false);
  });
});

describe('formatQuotaIndicator — width budget', () => {
  it('costs at most a few cells more than the bare-percentage form it replaced', () => {
    // The row already sheds fields on narrow terminals, so the hot form must not
    // balloon: `5h 94% · 7d 24%` (16 cells) → at most 8 more with a countdown.
    const hot = formatQuotaIndicator(
      {
        fiveHour: { utilization: 0.94, resetsAt: inMinutes(12) },
        sevenDay: { utilization: 0.24, resetsAt: inMinutes(5000) },
        observedAt: NOW,
      },
      NOW,
    );
    expect(displayWidth(stripAnsi(hot!.text))).toBeLessThanOrEqual(24);

    const calm = formatQuotaIndicator(
      { fiveHour: { utilization: 0.06 }, sevenDay: { utilization: 0.12 }, observedAt: NOW },
      NOW,
    );
    expect(displayWidth(stripAnsi(calm!.text))).toBeLessThanOrEqual(18);
  });
});

describe('formatResetCountdown', () => {
  it('never exceeds six columns across the full range', () => {
    // Widest possible form is `23h59m`; the 7d window can reach `6d23h`.
    for (const ms of [0, 30_000, 59_999, 60_000, 3_599_000, 3_600_000, 86_399_000, 86_400_000, 7 * 86_400_000]) {
      expect(displayWidth(formatResetCountdown(ms))).toBeLessThanOrEqual(6);
    }
  });

  it('formats sub-minute, minutes, hours+minutes, and days+hours', () => {
    expect(formatResetCountdown(30_000)).toBe('<1m');
    expect(formatResetCountdown(12 * 60_000)).toBe('12m');
    expect(formatResetCountdown((2 * 60 + 10) * 60_000)).toBe('2h10m');
    expect(formatResetCountdown((3 * 24 * 60 + 4 * 60) * 60_000)).toBe('3d4h');
  });

  it('drops the space the shared formatDuration would emit', () => {
    // Deliberate divergence from format-utils.ts's `2h 10m`: every cell counts on
    // a row that already sheds fields.
    expect(formatResetCountdown((2 * 60 + 10) * 60_000)).not.toContain(' ');
  });
});
