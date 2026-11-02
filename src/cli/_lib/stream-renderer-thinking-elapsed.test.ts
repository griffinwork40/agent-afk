/**
 * Regression tests for the summary-mode thinking elapsed indicator.
 *
 * Covers three layers:
 *  1. ThinkingLane.activeThinkingElapsedMs() — lifecycle gating
 *  2. checkThinkingAnnotation() — 1 Hz change detection + clearing
 *  3. Progress-banner slot — renders thinking banner in summary mode
 *
 * Each test documents the before-fix behaviour (what was broken) and the
 * after-fix behaviour (what should now work). The tests fail against the
 * pre-fix code and pass against the fix.
 *
 * @module cli/_lib/stream-renderer-thinking-elapsed.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import {
  checkThinkingAnnotation,
  THINKING_GRACE_MS,
  type LifecycleContext,
} from './stream-renderer-lifecycle.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { createStageTracker } from '../commands/interactive/loop-stage.js';
import type { Writer } from '../slash/types.js';

const writer: Writer = { line() {}, raw() {}, success() {}, info() {}, warn() {}, error() {} };

// ─── ThinkingLane.activeThinkingElapsedMs ──────────────────────────────────

describe('ThinkingLane.activeThinkingElapsedMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns null before any thinking chunks arrive', () => {
    const lane = new ThinkingLane();
    expect(lane.activeThinkingElapsedMs()).toBeNull();
  });

  it('returns elapsed ms during active thinking', () => {
    const lane = new ThinkingLane();
    lane.push('some reasoning');
    vi.advanceTimersByTime(5_000);
    expect(lane.activeThinkingElapsedMs()).toBe(5_000);
  });

  it('returns null after markEnded (tool dispatch / content)', () => {
    const lane = new ThinkingLane();
    lane.push('some reasoning');
    vi.advanceTimersByTime(3_000);
    lane.markEnded();
    // markEnded caps the window — activeThinkingElapsedMs should stop
    expect(lane.activeThinkingElapsedMs()).toBeNull();
  });

  it('returns null after collapse (turn finalization)', () => {
    const lane = new ThinkingLane();
    lane.push('some reasoning');
    vi.advanceTimersByTime(2_000);
    lane.collapse();
    // collapse sets hasEmitted — no longer active
    expect(lane.activeThinkingElapsedMs()).toBeNull();
  });

  it('returns null after consume', () => {
    const lane = new ThinkingLane();
    lane.push('some reasoning');
    vi.advanceTimersByTime(2_000);
    lane.consume();
    expect(lane.activeThinkingElapsedMs()).toBeNull();
  });

  it('clamps negative values to 0 (NTP step-back guard)', () => {
    const lane = new ThinkingLane();
    lane.push('some reasoning');
    // Simulate NTP stepping clock backward via setSystemTime
    vi.setSystemTime(new Date('2023-12-31T23:59:59.000Z'));
    expect(lane.activeThinkingElapsedMs()).toBe(0);
  });
});

// ─── checkThinkingAnnotation ──────────────────────────────────────────────

describe('checkThinkingAnnotation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  function makeCtx(overrides?: Partial<LifecycleContext>): LifecycleContext {
    const markDirty = vi.fn();
    return {
      compositor: null,
      overlayComposer: { markDirty, isDirty: () => false, flush: vi.fn(), invalidate: vi.fn(), register: vi.fn() } as never,
      stageTracker: createStageTracker(),
      thinkingLane: new ThinkingLane(),
      toolLane: new ToolLane(),
      streamingMarkdownRef: { current: null },
      lastProgressByTask: new Map(),
      thinkingMode: 'summary',
      out: writer,
      sources: new Map(),
      pauseTickInterval: null,
      resizeUnsub: null,
      ttfbStartedAt: undefined,
      ttfbDone: true,
      lastTtfbAnnotation: '',
      lastThinkingAnnotation: '',
      isTTY: true,
      disposed: false,
      ...overrides,
    };
  }

  it('returns false when not TTY', () => {
    const ctx = makeCtx({ isTTY: false });
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS + 1_000);
    expect(checkThinkingAnnotation(ctx, Date.now())).toBe(false);
  });

  it('returns false in live mode (thinking-live slot handles it)', () => {
    const ctx = makeCtx({ thinkingMode: 'live' });
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS + 1_000);
    expect(checkThinkingAnnotation(ctx, Date.now())).toBe(false);
  });

  it('returns false in digest mode', () => {
    const ctx = makeCtx({ thinkingMode: 'digest' });
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS + 1_000);
    expect(checkThinkingAnnotation(ctx, Date.now())).toBe(false);
  });

  it('returns false before grace period', () => {
    const ctx = makeCtx();
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS - 100);
    expect(checkThinkingAnnotation(ctx, Date.now())).toBe(false);
  });

  it('marks progress-banner dirty after grace period', () => {
    const ctx = makeCtx();
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS + 500);
    const result = checkThinkingAnnotation(ctx, Date.now());
    expect(result).toBe(true);
    expect(ctx.lastThinkingAnnotation).toBe('thinking:2');
    expect(ctx.overlayComposer!.markDirty).toHaveBeenCalledWith('progress-banner');
  });

  it('returns false on repeated ticks within the same second (1 Hz)', () => {
    const ctx = makeCtx();
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS + 500);
    checkThinkingAnnotation(ctx, Date.now());
    // 80ms later — same second
    vi.advanceTimersByTime(80);
    expect(checkThinkingAnnotation(ctx, Date.now())).toBe(false);
  });

  it('fires again at the next second boundary', () => {
    const ctx = makeCtx();
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS + 500);
    checkThinkingAnnotation(ctx, Date.now());
    // Advance to next second
    vi.advanceTimersByTime(500);
    expect(checkThinkingAnnotation(ctx, Date.now())).toBe(true);
    expect(ctx.lastThinkingAnnotation).toBe('thinking:3');
  });

  it('clears annotation when thinking ends (markEnded)', () => {
    const ctx = makeCtx();
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS + 500);
    checkThinkingAnnotation(ctx, Date.now());
    expect(ctx.lastThinkingAnnotation).toBe('thinking:2');

    // Simulate tool dispatch — markEnded caps the window
    ctx.thinkingLane.markEnded();
    const result = checkThinkingAnnotation(ctx, Date.now());
    expect(result).toBe(true); // dirty = true (clearing)
    expect(ctx.lastThinkingAnnotation).toBe('');
  });

  it('does not re-clear on subsequent ticks after thinking ends', () => {
    const ctx = makeCtx();
    ctx.thinkingLane.push('thinking');
    vi.advanceTimersByTime(THINKING_GRACE_MS + 500);
    checkThinkingAnnotation(ctx, Date.now());
    ctx.thinkingLane.markEnded();
    checkThinkingAnnotation(ctx, Date.now()); // clears
    // Next tick — already clear, should return false
    vi.advanceTimersByTime(80);
    expect(checkThinkingAnnotation(ctx, Date.now())).toBe(false);
  });
});

// ─── classifyError unknown hint ───────────────────────────────────────────

import { classifyError } from '../errors/classifier.js';

describe('classifyError — unknown fallback hint', () => {

  it('includes a hint for unknown errors', () => {
    const err = new Error('Something bizarre from the provider');
    const result = classifyError(err);
    expect(result.kind).toBe('unknown');
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('afk trace show');
  });

  it('includes a hint even for empty error messages', () => {
    const result = classifyError(new Error(''));
    expect(result.kind).toBe('unknown');
    expect(result.hint).toBeDefined();
  });
});
