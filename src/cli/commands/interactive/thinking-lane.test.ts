/**
 * ThinkingLane unit tests — pin the duration semantics so the "thought for
 * Xs" line reads as actual thinking time, not turn wall-clock.
 *
 * Regression context: before the markEnded() cap, `collapse()` computed
 * `Date.now() - startedAt`, where `startedAt` was set on the FIRST thinking
 * chunk and `Date.now()` was finalize time — i.e. AFTER text streaming and
 * tool calls had already happened. A 30s think followed by 150s of tools +
 * streaming would report "thought for 180s." Now the renderer calls
 * `markEnded()` on the first non-thinking event, freezing the window at the
 * thinking→acting transition.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThinkingLane, formatThoughtSummary } from './thinking-lane.js';

// Local ANSI stripper — palette wraps the line in chalk escapes; the test
// asserts on the visible substring. Matches the pattern at
// src/agent/tools/subagent-executor.ts:31.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('ThinkingLane — duration semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapse() reports wall-clock when markEnded was never called (pure-thinking turn)', () => {
    const lane = new ThinkingLane();
    lane.push('reasoning chunk one ');
    vi.advanceTimersByTime(5000); // 5s of thinking
    lane.push('reasoning chunk two');
    vi.advanceTimersByTime(2000); // 2s gap to finalize

    const line = stripAnsi(lane.collapse() ?? '');
    // 5s + 2s = 7s wall-clock window
    expect(line).toContain('thought for 7.0s');
  });

  it('collapse() caps duration at markEnded() — ignores wall-clock after the boundary', () => {
    const lane = new ThinkingLane();
    lane.push('reasoning chunk one ');
    vi.advanceTimersByTime(5000); // 5s of thinking
    lane.push('reasoning chunk two');
    vi.advanceTimersByTime(2000); // 7s elapsed since first chunk

    lane.markEnded(); // thinking→acting boundary
    vi.advanceTimersByTime(150_000); // 150s of tools + streaming after

    const line = stripAnsi(lane.collapse() ?? '');
    // Duration is FROZEN at markEnded(): 7s, not 7s + 150s = 157s.
    expect(line).toContain('thought for 7.0s');
    expect(line).not.toContain('157');
  });

  it('markEnded() is idempotent — only the first call freezes the window', () => {
    const lane = new ThinkingLane();
    lane.push('reasoning');
    vi.advanceTimersByTime(3000);
    lane.markEnded(); // freezes at t=3s

    vi.advanceTimersByTime(10_000);
    lane.markEnded(); // no-op — should not move the boundary to t=13s

    const line = stripAnsi(lane.collapse() ?? '');
    expect(line).toContain('thought for 3.0s');
  });

  it('markEnded() is a no-op when no thinking has been observed yet', () => {
    const lane = new ThinkingLane();
    lane.markEnded(); // no-op — no startedAt yet
    expect(lane.collapse()).toBeNull();

    // Pushing after a stray markEnded() still works — endedAt stays null
    // until the next markEnded() observes a non-null startedAt.
    lane.push('reasoning');
    vi.advanceTimersByTime(4000);
    const line = stripAnsi(lane.collapse() ?? '');
    expect(line).toContain('thought for 4.0s');
  });

  it('inlineSummary() honors the markEnded() cap', () => {
    // Subagent Done rows surface `· thought Xs · N tok` via inlineSummary —
    // the same fix must apply or the subagent annotation goes back to
    // reporting turn-end wall-clock.
    const lane = new ThinkingLane();
    lane.push('subagent reasoning');
    vi.advanceTimersByTime(2000);
    lane.markEnded();
    vi.advanceTimersByTime(60_000); // 60s of subagent tool work after thinking

    const inline = lane.inlineSummary();
    expect(inline).toContain('thought 2.0s');
    expect(inline).not.toContain('62');
  });

  it('inlineSummary() does NOT flip hasEmitted — caller can still collapse later', () => {
    const lane = new ThinkingLane();
    lane.push('reasoning');
    vi.advanceTimersByTime(1500);
    lane.markEnded();

    expect(lane.inlineSummary()).toBeTruthy();
    // collapse must still produce a line after inlineSummary was called.
    const collapsed = stripAnsi(lane.collapse() ?? '');
    expect(collapsed).toContain('thought for 1.5s');
    // Second collapse is the documented terminal state.
    expect(lane.collapse()).toBeNull();
  });

  it('clamps duration at 0 when the clock steps backward (NTP correction)', () => {
    // Date.now() is not monotonic — NTP can step the wall clock backward
    // between the startedAt and endedAt samples. Without Math.max(0, …),
    // duration goes negative, satisfies `< 1000`, and renders as
    // "thought for -42ms". Pin the guard for both call sites.
    const lane = new ThinkingLane();
    lane.push('reasoning');
    vi.advanceTimersByTime(5000); // forward to t=5s

    // Simulate NTP stepping the clock back 10s — endedAt sample < startedAt.
    vi.setSystemTime(new Date('2023-12-31T23:59:55.000Z'));
    lane.markEnded();

    const collapsed = stripAnsi(lane.collapse() ?? '');
    expect(collapsed).toContain('thought for 0ms');
    expect(collapsed).not.toMatch(/-\d/);
  });

  it('inlineSummary() also clamps duration at 0 on clock skew', () => {
    const lane = new ThinkingLane();
    lane.push('subagent reasoning');
    vi.advanceTimersByTime(3000);

    // NTP step backward between startedAt and endedAt.
    vi.setSystemTime(new Date('2023-12-31T23:59:50.000Z'));
    lane.markEnded();

    const inline = lane.inlineSummary() ?? '';
    expect(inline).toContain('thought 0ms');
    expect(inline).not.toMatch(/-\d/);
  });
});

describe('ThinkingLane — per-phase interleaving (peekPhase / drainPhase)', () => {
  it('peekPhase() returns only the uncommitted phase; drainPhase() advances the pointer', () => {
    const lane = new ThinkingLane();
    lane.push('phase one reasoning ');
    expect(lane.peekPhase()).toBe('phase one reasoning ');

    // Seal phase one — drainPhase returns it and advances the commit pointer.
    expect(lane.drainPhase()).toBe('phase one reasoning ');
    // After a seal the current phase is empty until the next push (so the
    // live overlay clears rather than re-showing collapsed reasoning).
    expect(lane.peekPhase()).toBe('');

    lane.push('phase two reasoning');
    expect(lane.peekPhase()).toBe('phase two reasoning');
    expect(lane.drainPhase()).toBe('phase two reasoning');
    expect(lane.peekPhase()).toBe('');
  });

  it('drainPhase() leaves the cumulative buffer intact for peek()/collapse()', () => {
    const lane = new ThinkingLane();
    lane.push('alpha ');
    lane.drainPhase();
    lane.push('beta');
    lane.drainPhase();

    // Cumulative methods (subagent / non-TTY paths) are unaffected by draining.
    expect(lane.peek()).toBe('alpha beta');
    // 'alpha beta' = 10 chars → ceil(10/4) = 3 tok
    expect(stripAnsi(lane.collapse() ?? '')).toContain('3 tok');
  });

  it('peekPhase()/drainPhase() are empty before any push', () => {
    const lane = new ThinkingLane();
    expect(lane.peekPhase()).toBe('');
    expect(lane.drainPhase()).toBe('');
  });
});

describe('formatThoughtSummary', () => {
  it('renders sub-second durations in ms and ≥1s in s, with a token estimate', () => {
    expect(stripAnsi(formatThoughtSummary(420, 320))).toContain('thought for 420ms · 80 tok');
    expect(stripAnsi(formatThoughtSummary(1500, 320))).toContain('thought for 1.5s · 80 tok');
  });

  it('clamps negative durations (NTP step-back) to 0ms', () => {
    const line = stripAnsi(formatThoughtSummary(-42, 0));
    expect(line).toContain('thought for 0ms');
    expect(line).not.toMatch(/-\d/);
  });
});
