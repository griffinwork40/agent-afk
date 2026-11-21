/**
 * Unit tests for the Shift+Tab permission-mode cycle.
 *
 * `cyclePermissionMode` advances the two-stop ring: plan ↔ bypassPermissions.
 * `default` has been removed — `bypassPermissions` is the baseline mode.
 * plan/bypass transitions are pure setPermissionMode flips with the same
 * rejection contract as togglePlanMode (leave stats unchanged + surface error).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cyclePermissionMode, PERMISSION_CYCLE } from './permission-mode-cycle.js';
import type { SessionStats, SlashContext } from './slash/types.js';

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    unpricedTurns: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
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

describe('cyclePermissionMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ring constant is [plan, bypassPermissions] and excludes autonomous', () => {
    expect(PERMISSION_CYCLE).toEqual(['plan', 'bypassPermissions']);
    expect(PERMISSION_CYCLE as readonly string[]).not.toContain('autonomous');
    expect(PERMISSION_CYCLE as readonly string[]).not.toContain('default');
  });

  it('bypassPermissions → plan and emits plan ON copy', async () => {
    const stats = makeStats({ permissionMode: 'bypassPermissions' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await cyclePermissionMode(ctx);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(stats.permissionMode).toBe('plan');
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalled();
    expect(lines.join('\n').toLowerCase()).toContain('plan mode on');
  });

  it('plan → bypassPermissions and emits bypass copy', async () => {
    const stats = makeStats({ permissionMode: 'plan' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await cyclePermissionMode(ctx);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(stats.permissionMode).toBe('bypassPermissions');
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalled();
    expect(lines.join('\n').toLowerCase()).toContain('bypass on');
  });

  it('out-of-ring mode (e.g. acceptEdits) falls back to plan (index 0)', async () => {
    const stats = makeStats({ permissionMode: 'acceptEdits' });
    const { ctx, sess } = makeCtx({ stats });

    await cyclePermissionMode(ctx);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(stats.permissionMode).toBe('plan');
  });

  it('deprecated default mode falls back to plan (index 0)', async () => {
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, sess } = makeCtx({ stats });

    await cyclePermissionMode(ctx);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(stats.permissionMode).toBe('plan');
  });

  it('leaves permissionMode unchanged and surfaces an error when setPermissionMode rejects', async () => {
    // Mirrors togglePlanMode's failure contract: a provider query-handle
    // rejection must NOT advance stats.permissionMode (the prompt/status line
    // read it back).
    const setPermissionMode = vi.fn().mockRejectedValue(new Error('boom'));
    const stats = makeStats({ permissionMode: 'bypassPermissions' });
    const { ctx, lines } = makeCtx({ stats, setPermissionMode });

    await cyclePermissionMode(ctx);

    expect(setPermissionMode).toHaveBeenCalledWith('plan');
    expect(stats.permissionMode).toBe('bypassPermissions');
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });

  describe('mode-notice routing (toggle, not log)', () => {
    it('routes copy to the live compositor notice and writes nothing to scrollback', async () => {
      const stats = makeStats({ permissionMode: 'bypassPermissions' });
      const { ctx, lines } = makeCtx({ stats });
      const setModeNotice = vi.fn(() => true);
      ctx.getCompositor = () => ({ setModeNotice }) as unknown as ReturnType<NonNullable<SlashContext['getCompositor']>>;

      await cyclePermissionMode(ctx); // bypass → plan
      await cyclePermissionMode(ctx); // plan → bypass

      expect(setModeNotice).toHaveBeenCalledTimes(2);
      expect(String(setModeNotice.mock.calls[0]).toLowerCase()).toContain('plan mode on');
      expect(String(setModeNotice.mock.calls[1]).toLowerCase()).toContain('bypass on');
      expect(lines).toEqual([]);
    });

    it('falls back to one scrollback line when the compositor is disarmed', async () => {
      const stats = makeStats({ permissionMode: 'bypassPermissions' });
      const { ctx, lines } = makeCtx({ stats });
      ctx.getCompositor = () => ({ setModeNotice: () => false }) as unknown as ReturnType<NonNullable<SlashContext['getCompositor']>>;

      await cyclePermissionMode(ctx);

      expect(lines).toHaveLength(1);
      expect(lines[0]!.toLowerCase()).toContain('plan mode on');
    });

    it('falls back to scrollback when no compositor exists (null)', async () => {
      const stats = makeStats({ permissionMode: 'plan' });
      const { ctx, lines } = makeCtx({ stats });
      ctx.getCompositor = () => null;

      await cyclePermissionMode(ctx);

      expect(lines).toHaveLength(1);
      expect(lines[0]!.toLowerCase()).toContain('bypass on');
    });
  });
});
