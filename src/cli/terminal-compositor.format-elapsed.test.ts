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
 * and the padStart zero-padding on the seconds remainder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatElapsed, ELAPSED_GRACE_MS } from './terminal-compositor.scrollback.js';
import { stripAnsi } from './display.js';

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
});
