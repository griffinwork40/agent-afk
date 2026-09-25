/**
 * Unit tests for `formatElapsed` (#826) — the only one of the 7 functions
 * moved out of terminal-compositor.types.ts in this split that had no prior
 * direct test coverage. The other 6 are exercised elsewhere:
 * buildBandMeta/scrollbackFlushLines/snapFlushCountToLogicalBoundary/
 * buildScrollbackArchiveEscape by terminal-compositor.logical-flush.test.ts,
 * formatTipRow by loading-tips.test.ts, and eraseAndPaintRow by
 * terminal-compositor.render-not-repin.test.ts +
 * terminal-compositor.resize-stale-width.repro.test.ts.
 *
 * Covers the grace-period gate (nothing rendered before ELAPSED_GRACE_MS),
 * the seconds-only vs. minutes+seconds format switch at the 60s boundary,
 * the padStart zero-padding on the seconds remainder, and the C-2 adaptive
 * color thresholds (dim -> amber -> red).
 */

import type { ChalkInstance } from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatElapsed, ELAPSED_GRACE_MS, ELAPSED_AMBER_SEC, ELAPSED_RED_SEC } from './terminal-compositor.scrollback.js';
import { stripAnsi } from './display.js';
import { palette } from './palette.js';

/**
 * A stand-in `ChalkInstance` that renders `TAG:text` uncolored. Used to
 * verify which palette role `elapsedTone` selected without relying on
 * Chalk's ANSI output (which auto-disables under NO_COLOR / non-TTY).
 * Matches the sentinelChalk pattern in tool-lane-format.test.ts.
 */
function sentinelChalk(tag: string): ChalkInstance {
  return ((...text: unknown[]) => `${tag}:${text.join(' ')}`) as ChalkInstance;
}

describe('formatElapsed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty string before the grace period elapses', () => {
    const startedAt = Date.now();
    expect(formatElapsed(startedAt)).toBe('');
  });

  it('returns empty string right up to (but not including) ELAPSED_GRACE_MS', () => {
    const startedAt = Date.now() - (ELAPSED_GRACE_MS - 1);
    expect(formatElapsed(startedAt)).toBe('');
  });

  it('renders seconds-only once the grace period has elapsed', () => {
    const startedAt = Date.now() - 5_000;
    expect(stripAnsi(formatElapsed(startedAt))).toBe(' 5s');
  });

  it('renders seconds-only up to and including 59s', () => {
    const startedAt = Date.now() - 59_000;
    expect(stripAnsi(formatElapsed(startedAt))).toBe(' 59s');
  });

  it('switches to minutes+seconds at exactly 60s, zero-padding the seconds', () => {
    const startedAt = Date.now() - 60_000;
    expect(stripAnsi(formatElapsed(startedAt))).toBe(' 1m00s');
  });

  it('zero-pads a single-digit seconds remainder in the minutes form', () => {
    const startedAt = Date.now() - 65_000; // 1m05s
    expect(stripAnsi(formatElapsed(startedAt))).toBe(' 1m05s');
  });

  it('renders multi-minute durations without zero-padding the minutes', () => {
    const startedAt = Date.now() - (12 * 60_000 + 34_000); // 12m34s
    expect(stripAnsi(formatElapsed(startedAt))).toBe(' 12m34s');
  });

  it('applies a dim tint (non-empty ANSI wrapping) once past the grace period', () => {
    const startedAt = Date.now() - 5_000;
    const raw = formatElapsed(startedAt);
    // Only assert tinting is present when the active chalk level actually
    // emits escapes (NO_COLOR / non-TTY test runs strip it to plain text).
    if (raw !== stripAnsi(raw)) {
      expect(raw.length).toBeGreaterThan(stripAnsi(raw).length);
    }
    expect(stripAnsi(raw)).toBe(' 5s');
  });

  // C-2 adaptive color threshold tests (sentinel pattern avoids NO_COLOR vacuous passes).

  it('uses palette.dim below the amber threshold', () => {
    const savedDim = palette.dim;
    const savedWarning = palette.warning;
    const savedError = palette.error;
    try {
      palette.dim = sentinelChalk('DIM');
      palette.warning = sentinelChalk('WARN');
      palette.error = sentinelChalk('ERR');
      const startedAt = Date.now() - 5_000; // 5s, below ELAPSED_AMBER_SEC (10)
      const raw = formatElapsed(startedAt);
      expect(raw).toContain('DIM:');
      expect(raw).not.toContain('WARN:');
      expect(raw).not.toContain('ERR:');
    } finally {
      palette.dim = savedDim;
      palette.warning = savedWarning;
      palette.error = savedError;
    }
  });

  it('switches to palette.warning at exactly ELAPSED_AMBER_SEC', () => {
    const savedDim = palette.dim;
    const savedWarning = palette.warning;
    const savedError = palette.error;
    try {
      palette.dim = sentinelChalk('DIM');
      palette.warning = sentinelChalk('WARN');
      palette.error = sentinelChalk('ERR');

      // Exactly at amber threshold (10s)
      const atAmber = Date.now() - ELAPSED_AMBER_SEC * 1_000;
      const rawAmber = formatElapsed(atAmber);
      expect(rawAmber).toContain('WARN:');
      expect(rawAmber).not.toContain('DIM:');
      expect(rawAmber).not.toContain('ERR:');

      // One second before: still dim
      const beforeAmber = Date.now() - (ELAPSED_AMBER_SEC - 1) * 1_000;
      const rawBefore = formatElapsed(beforeAmber);
      expect(rawBefore).toContain('DIM:');
      expect(rawBefore).not.toContain('WARN:');
    } finally {
      palette.dim = savedDim;
      palette.warning = savedWarning;
      palette.error = savedError;
    }
  });

  it('switches to palette.error at exactly ELAPSED_RED_SEC', () => {
    const savedWarning = palette.warning;
    const savedError = palette.error;
    try {
      palette.warning = sentinelChalk('WARN');
      palette.error = sentinelChalk('ERR');

      // Exactly at red threshold (60s)
      const atRed = Date.now() - ELAPSED_RED_SEC * 1_000;
      const rawRed = formatElapsed(atRed);
      expect(rawRed).toContain('ERR:');
      expect(rawRed).not.toContain('WARN:');

      // One second before (59s): still warning
      const beforeRed = Date.now() - (ELAPSED_RED_SEC - 1) * 1_000;
      const rawBefore = formatElapsed(beforeRed);
      expect(rawBefore).toContain('WARN:');
      expect(rawBefore).not.toContain('ERR:');
    } finally {
      palette.warning = savedWarning;
      palette.error = savedError;
    }
  });
});
