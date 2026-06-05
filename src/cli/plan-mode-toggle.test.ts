/**
 * Unit tests for plan-mode-toggle helpers.
 *
 * `togglePlanMode` is exercised indirectly throughout slash-commands.test.ts.
 * This file focuses on `flushPendingPlanExit` — the closure-ritual
 * terminator called from `repl-loop.ts:onAfterTurn`. The terminator is
 * load-bearing for the D-light architecture: it is the *only* code path
 * that flips plan→default after the model emits its closure response,
 * and its failure semantics (preserve the pending flag when
 * `setPermissionMode` rejects) are what make repeated `/plan off` safe
 * instead of stuck in a ritual loop.
 */

import { describe, it, expect, vi } from 'vitest';
import { flushPendingPlanExit, togglePlanMode } from './plan-mode-toggle.js';
import type { SessionStats, SlashContext } from './slash/types.js';

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    planMode: false,
    ...overrides,
  };
}

interface FakeSession {
  setPermissionMode: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: {
  stats: SessionStats;
  setPermissionMode?: ReturnType<typeof vi.fn>;
}): { ctx: SlashContext; sess: FakeSession; lines: string[] } {
  const lines: string[] = [];
  const sess: FakeSession = {
    setPermissionMode: opts.setPermissionMode ?? vi.fn().mockResolvedValue(undefined),
  };
  const ctx: SlashContext = {
    session: { current: sess } as unknown as SlashContext['session'],
    stats: opts.stats,
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`SUCCESS:${t}`),
      info: (t) => lines.push(`INFO:${t}`),
      warn: (t) => lines.push(`WARN:${t}`),
      error: (t) => lines.push(`ERROR:${t}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, sess, lines };
}

describe('flushPendingPlanExit', () => {
  it('is a no-op when pendingPlanExit is unset', async () => {
    const stats = makeStats({ planMode: true });
    const { ctx, sess } = makeCtx({ stats });

    await flushPendingPlanExit(ctx);

    expect(sess.setPermissionMode).not.toHaveBeenCalled();
    expect(stats.planMode).toBe(true);
    expect(stats.pendingPlanExit).toBeFalsy();
  });

  it('is a no-op when pendingPlanExit is explicitly false', async () => {
    const stats = makeStats({ planMode: true, pendingPlanExit: false });
    const { ctx, sess } = makeCtx({ stats });

    await flushPendingPlanExit(ctx);

    expect(sess.setPermissionMode).not.toHaveBeenCalled();
    expect(stats.planMode).toBe(true);
  });

  it('flips planMode to false and clears the pending flag when the flip succeeds', async () => {
    const stats = makeStats({ planMode: true, pendingPlanExit: true });
    const { ctx, sess } = makeCtx({ stats });

    await flushPendingPlanExit(ctx);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.planMode).toBe(false);
    expect(stats.pendingPlanExit).toBe(false);
  });

  it('preserves the pending flag when setPermissionMode throws (retry-safe)', async () => {
    // Simulate the provider's query handle rejecting (e.g., closing or
    // already torn down). togglePlanMode catches the error internally
    // (emits ERROR: line) and leaves planMode unchanged.
    // flushPendingPlanExit reads planMode after the call and must NOT
    // clear pendingPlanExit so the next /plan off lands as a clean
    // force-exit, not a fresh ritual.
    const setPermissionMode = vi.fn().mockRejectedValue(new Error('boom'));
    const stats = makeStats({ planMode: true, pendingPlanExit: true });
    const { ctx, lines } = makeCtx({ stats, setPermissionMode });

    await flushPendingPlanExit(ctx);

    expect(setPermissionMode).toHaveBeenCalledWith('default');
    // Mode did NOT flip.
    expect(stats.planMode).toBe(true);
    // Pending flag preserved for retry.
    expect(stats.pendingPlanExit).toBe(true);
    // togglePlanMode's internal catch surfaced an error line.
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });

  it('is safe to call repeatedly when the flip keeps failing', async () => {
    // Three sequential failures should all preserve the flag; mode never
    // flips; user can still force-exit via /plan off (which short-circuits
    // because pendingPlanExit is true).
    const setPermissionMode = vi.fn().mockRejectedValue(new Error('boom'));
    const stats = makeStats({ planMode: true, pendingPlanExit: true });
    const { ctx } = makeCtx({ stats, setPermissionMode });

    await flushPendingPlanExit(ctx);
    await flushPendingPlanExit(ctx);
    await flushPendingPlanExit(ctx);

    expect(setPermissionMode).toHaveBeenCalledTimes(3);
    expect(stats.planMode).toBe(true);
    expect(stats.pendingPlanExit).toBe(true);
  });
});

describe('togglePlanMode — closureSummarySkipped copy', () => {
  it('emits force-exit OFF copy when closureSummarySkipped=true', async () => {
    const stats = makeStats({ planMode: true });
    const { ctx, lines } = makeCtx({ stats });

    await togglePlanMode(ctx, false, { closureSummarySkipped: true });

    expect(stats.planMode).toBe(false);
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('plan mode off');
    expect(joined).toContain('force-exit');
    expect(joined).toContain('closure summary skipped');
  });

  it('emits normal OFF copy when closureSummarySkipped is unset (default)', async () => {
    const stats = makeStats({ planMode: true });
    const { ctx, lines } = makeCtx({ stats });

    await togglePlanMode(ctx, false);

    expect(stats.planMode).toBe(false);
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('plan mode off');
    expect(joined).toContain('default permissions restored');
    // MUST NOT advertise force-exit semantics on a normal exit.
    expect(joined).not.toContain('force-exit');
    expect(joined).not.toContain('closure summary skipped');
  });

  it('ignores closureSummarySkipped when toggling ON (plan-mode entry has its own copy)', async () => {
    const stats = makeStats({ planMode: false });
    const { ctx, lines } = makeCtx({ stats });

    await togglePlanMode(ctx, true, { closureSummarySkipped: true });

    expect(stats.planMode).toBe(true);
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('plan mode on');
    expect(joined).not.toContain('force-exit');
  });

  it('emits normal OFF copy when post-closure flush flips the mode (flushPendingPlanExit path)', async () => {
    // Regression guard for the subtle case: flushPendingPlanExit calls
    // togglePlanMode(false) WITHOUT closureSummarySkipped because the
    // closure summary DID just fire (in the previous turn). The OFF copy
    // must be the normal one, not "force-exit". This protects against a
    // future refactor that might decide "pendingPlanExit was set, must
    // be a skip" — which would be wrong on the post-closure path.
    const stats = makeStats({ planMode: true, pendingPlanExit: true });
    const { ctx, lines } = makeCtx({ stats });

    await flushPendingPlanExit(ctx);

    expect(stats.planMode).toBe(false);
    expect(stats.pendingPlanExit).toBe(false);
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('plan mode off');
    expect(joined).toContain('default permissions restored');
    expect(joined).not.toContain('force-exit');
    expect(joined).not.toContain('closure summary skipped');
  });
});

describe('Shift+Tab equivalent — force-exit while pendingPlanExit (repl-loop handler logic)', () => {
  // The Shift+Tab keybinding lives in repl-loop.ts and is not directly
  // unit-testable, but its body is two lines: clear pendingPlanExit, then
  // call togglePlanMode with `closureSummarySkipped: true`. This test
  // exercises that exact sequence on the same stats/session shape so a
  // refactor that breaks the sequence breaks this test.

  it('clears pendingPlanExit and emits force-exit copy', async () => {
    const stats = makeStats({ planMode: true, pendingPlanExit: true });
    const { ctx, sess, lines } = makeCtx({ stats });

    // Simulate the repl-loop Shift+Tab handler body.
    stats.pendingPlanExit = false;
    await togglePlanMode(ctx, false, { closureSummarySkipped: true });

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.planMode).toBe(false);
    expect(stats.pendingPlanExit).toBe(false);

    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('force-exit');
    expect(joined).toContain('closure summary skipped');
  });

  it('post Shift+Tab force-exit, flushPendingPlanExit is a no-op (no double-OFF line)', async () => {
    // Regression guard for the Path 3 bug the audit caught: previously,
    // Shift+Tab cleared planMode but not pendingPlanExit, so onAfterTurn
    // would call flushPendingPlanExit which would emit a SECOND
    // "plan mode OFF" line on the next turn. Wiring fix: Shift+Tab now
    // clears pendingPlanExit, so flushPendingPlanExit short-circuits.
    const stats = makeStats({ planMode: true, pendingPlanExit: true });
    const { ctx, sess } = makeCtx({ stats });

    // Shift+Tab force-exit sequence.
    stats.pendingPlanExit = false;
    await togglePlanMode(ctx, false, { closureSummarySkipped: true });

    // After Shift+Tab: mode is off, flag is cleared.
    expect(stats.planMode).toBe(false);
    expect(stats.pendingPlanExit).toBe(false);

    const callCountAfterShiftTab = sess.setPermissionMode.mock.calls.length;

    // Simulate onAfterTurn on the NEXT turn.
    await flushPendingPlanExit(ctx);

    // No additional setPermissionMode call, no additional OFF line.
    expect(sess.setPermissionMode.mock.calls.length).toBe(callCountAfterShiftTab);
  });
});
