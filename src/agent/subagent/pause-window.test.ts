/**
 * Unit tests for the shared pause-window arithmetic consumed by BOTH bounds on a
 * forked sub-agent turn — {@link import('./idle-watchdog.js').IdleWatchdog} (the
 * resettable idle bound) and
 * {@link import('./pause-ceiling.js').PauseAwareCeiling} (the wall-clock
 * ceiling). Extracted so the two cannot drift apart. Covers:
 *   - `paused` with resetsAt → resetsAt - now + slack
 *   - `paused` without resetsAt → undefined (no knowable window)
 *   - `rate_limit` with retryAfterMs → retryAfterMs + slack
 *   - `rate_limit` with absent / zero / negative / non-finite retryAfterMs → undefined
 *   - a resetsAt already in the past yields a non-positive window (callers floor it)
 *   - non-pause events → undefined
 *   - describePauseEvent renders diagnosable context for pause events only
 */

import { describe, it, expect } from 'vitest';

import { PAUSE_WINDOW_SLACK_MS, describePauseEvent, pauseWindowMs } from './pause-window.js';
import type { OutputEvent } from '../types/session-types.js';

describe('pauseWindowMs', () => {
  const now = Date.parse('2026-07-31T02:00:00.000Z');

  it('returns resetsAt - now + slack for a `paused` event carrying resetsAt', () => {
    const event: OutputEvent = {
      type: 'paused',
      reason: 'usage-limit',
      resetsAt: new Date(now + 90 * 60_000),
    };
    expect(pauseWindowMs(event, now)).toBe(90 * 60_000 + PAUSE_WINDOW_SLACK_MS);
  });

  it('returns undefined for a `paused` event with no resetsAt (oauth-limit-no-ts)', () => {
    expect(pauseWindowMs({ type: 'paused', reason: 'usage-limit' }, now)).toBeUndefined();
  });

  it('returns retryAfterMs + slack for a `rate_limit` event carrying retryAfterMs', () => {
    expect(pauseWindowMs({ type: 'rate_limit', retryAfterMs: 60_000 }, now)).toBe(
      60_000 + PAUSE_WINDOW_SLACK_MS,
    );
  });

  it('returns undefined for a `rate_limit` with an absent or unusable retryAfterMs', () => {
    expect(pauseWindowMs({ type: 'rate_limit' }, now)).toBeUndefined();
    expect(pauseWindowMs({ type: 'rate_limit', retryAfterMs: 0 }, now)).toBeUndefined();
    expect(pauseWindowMs({ type: 'rate_limit', retryAfterMs: -5 }, now)).toBeUndefined();
    expect(pauseWindowMs({ type: 'rate_limit', retryAfterMs: Number.NaN }, now)).toBeUndefined();
    expect(
      pauseWindowMs({ type: 'rate_limit', retryAfterMs: Number.POSITIVE_INFINITY }, now),
    ).toBeUndefined();
  });

  it('yields a non-positive window when resetsAt has already passed (callers apply the floor)', () => {
    const event: OutputEvent = {
      type: 'paused',
      reason: 'usage-limit',
      resetsAt: new Date(now - 10 * 60_000),
    };
    // Deliberately NOT clamped here: the idle watchdog floors up to a normal
    // idle window, while the ceiling grants no extension. Neither may inherit
    // the other's policy.
    expect(pauseWindowMs(event, now)).toBe(-10 * 60_000 + PAUSE_WINDOW_SLACK_MS);
  });

  it('returns undefined for non-pause events', () => {
    expect(pauseWindowMs({ type: 'chunk', chunk: { type: 'content', content: 'x' } }, now)).toBeUndefined();
    expect(pauseWindowMs({ type: 'resumed', hotSwapped: false }, now)).toBeUndefined();
    expect(pauseWindowMs({ type: 'stream_retry' }, now)).toBeUndefined();
  });
});

describe('describePauseEvent', () => {
  it('names the reason and resetsAt for a `paused` event', () => {
    const resetsAt = new Date('2026-07-31T03:10:00.000Z');
    expect(describePauseEvent({ type: 'paused', reason: 'usage-limit', resetsAt })).toBe(
      'paused (usage-limit, resetsAt=2026-07-31T03:10:00.000Z)',
    );
  });

  it('marks an unknown resetsAt rather than omitting it', () => {
    expect(describePauseEvent({ type: 'paused', reason: 'usage-limit' })).toContain(
      'resetsAt=unknown',
    );
  });

  it('names retryAfterMs for a `rate_limit` event', () => {
    expect(describePauseEvent({ type: 'rate_limit', retryAfterMs: 6_792_000 })).toBe(
      'rate_limit (retryAfterMs=6792000)',
    );
    expect(describePauseEvent({ type: 'rate_limit' })).toContain('retryAfterMs=unknown');
  });

  it('returns undefined for non-pause events', () => {
    expect(describePauseEvent({ type: 'resumed', hotSwapped: false })).toBeUndefined();
    expect(
      describePauseEvent({ type: 'chunk', chunk: { type: 'content', content: 'x' } }),
    ).toBeUndefined();
  });
});
