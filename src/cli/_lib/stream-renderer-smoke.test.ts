/**
 * armSmokeEffects gating + commitThinkingPhase routing.
 *
 * Pins:
 *  1. Flag off (or reduced motion, or <256 colors) → null, and NOTHING is
 *     touched: no slot registered, no fade on the lane, no timer.
 *  2. Flag on → the thought-summary slot is registered and the lane fades.
 *  3. commitThinkingPhase holds the single stat line when a hold is present,
 *     and commits it directly (unchanged path) when absent. Digest blocks
 *     (multi-line) always commit directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { armSmokeEffects, THOUGHT_SUMMARY_SLOT } from './stream-renderer-smoke.js';
import { OverlayComposer } from './overlay-composer.js';
import { ToolLane } from '../commands/interactive/tool-lane.js';
import { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import { commitThinkingPhase } from './stream-renderer-orchestrator-emit.js';
import { freshSourceState } from './stream-renderer-source.js';
import { resetSmokeToneCache } from '../smoke-reveal.tones.js';

function harness(): {
  composer: OverlayComposer;
  register: ReturnType<typeof vi.spyOn>;
  lane: ToolLane;
  compositor: { commitAbove: ReturnType<typeof vi.fn>; setCommitBarrier: ReturnType<typeof vi.fn>; setOverlay: ReturnType<typeof vi.fn> };
} {
  const compositor = { commitAbove: vi.fn(), setCommitBarrier: vi.fn(), setOverlay: vi.fn() };
  const composer = new OverlayComposer(compositor, [THOUGHT_SUMMARY_SLOT, 'tool-lane']);
  const register = vi.spyOn(composer, 'register');
  return { composer, register, lane: new ToolLane(), compositor };
}

let savedLevel: typeof chalk.level;
beforeEach(() => {
  vi.useFakeTimers();
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
  vi.stubEnv('AFK_PLAIN_OUTPUT', '');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  chalk.level = savedLevel;
});

describe('armSmokeEffects', () => {
  const arm = (h: ReturnType<typeof harness>, reducedMotion = false) =>
    armSmokeEffects({ compositor: h.compositor, overlayComposer: h.composer, toolLane: h.lane, reducedMotion, deferFlush: vi.fn() });

  it.each([
    ['AFK_SMOKE_TEXT unset', '', 3, false],
    ['AFK_SMOKE_TEXT=0', '0', 3, false],
    ['reduced motion', '1', 3, true],
    ['16-color terminal', '1', 1, false],
  ] as const)('returns null and touches nothing when %s', (_label, flag, level, reduced) => {
    vi.stubEnv('AFK_SMOKE_TEXT', flag);
    chalk.level = level;
    const h = harness();
    h.lane.addStart('t1', 'Read', '("a.ts")');
    const before = h.lane.getOverlay();
    expect(arm(h, reduced)).toBeNull();
    expect(h.register).not.toHaveBeenCalled();
    expect(h.lane.fade).toBeNull();
    expect(h.lane.getOverlay()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wires the summary slot and the lane fade when enabled; dispose detaches', () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    const h = harness();
    const fx = arm(h);
    expect(fx).not.toBeNull();
    expect(h.register).toHaveBeenCalledWith(expect.objectContaining({ key: THOUGHT_SUMMARY_SLOT }));
    expect(h.lane.fade).not.toBeNull();
    fx!.thoughtHold.hold('   ◆ thought for 1.0s · 10 tokens');
    fx!.dispose();
    expect(h.compositor.commitAbove).toHaveBeenCalledWith('   ◆ thought for 1.0s · 10 tokens');
    expect(h.lane.fade).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('commitThinkingPhase routing', () => {
  function ctxFor(mode: 'summary' | 'digest', hold?: { hold: ReturnType<typeof vi.fn> }) {
    const compositor = { commitAbove: vi.fn(), setOverlay: vi.fn(), setSpinner: vi.fn() };
    const thinkingLane = new ThinkingLane();
    thinkingLane.push('weighing the two options carefully');
    const ctx = {
      out: { line: vi.fn() },
      isTTY: true,
      compositor,
      toolLane: new ToolLane(),
      thinkingLane,
      thinkingMode: mode,
      streamingMarkdown: { current: null },
      lastProgressByTask: new Map(),
      coordinator: { schedule: vi.fn() },
      ...(hold ? { thoughtHold: hold } : {}),
    };
    const source = freshSourceState(undefined);
    source.thinkingPhaseStartedAt = Date.now() - 1500;
    return { ctx, source, compositor };
  }

  it('commits the stat line directly when no hold is present (smoke off)', () => {
    const { ctx, source, compositor } = ctxFor('summary');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitThinkingPhase(source, ctx as any);
    expect(compositor.commitAbove).toHaveBeenCalledTimes(1);
    expect(compositor.commitAbove.mock.calls[0]![0]).toContain('thought for');
  });

  it('hands the exact stat line to the hold instead of committing it (smoke on)', () => {
    const hold = { hold: vi.fn() };
    const direct = ctxFor('summary');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitThinkingPhase(direct.source, direct.ctx as any);
    const expected = direct.compositor.commitAbove.mock.calls[0]![0] as string;

    const held = ctxFor('summary', hold);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitThinkingPhase(held.source, held.ctx as any);
    expect(held.compositor.commitAbove).not.toHaveBeenCalled();
    expect(hold.hold).toHaveBeenCalledTimes(1);
    expect(hold.hold.mock.calls[0]![0]).toBe(expected);
  });

  it('commits a digest block directly even when a hold is present', () => {
    const hold = { hold: vi.fn() };
    const { ctx, source, compositor } = ctxFor('digest', hold);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitThinkingPhase(source, ctx as any);
    expect(hold.hold).not.toHaveBeenCalled();
    expect(compositor.commitAbove).toHaveBeenCalledTimes(1);
    expect(compositor.commitAbove.mock.calls[0]![0]).toContain('thought for');
  });
});
