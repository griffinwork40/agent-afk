/**
 * Unit tests for the plan-mode toggle helper.
 *
 * `togglePlanMode` flips the session permission mode ('plan' <-> 'default'),
 * mirrors the result onto `stats.permissionMode`, and emits the ON/OFF copy. It is
 * the shared primitive behind both the /plan slash command and the Shift+Tab
 * keybinding. The exit-and-implement behavior lives in the slash command
 * (`slash/commands/plan.ts`), not here — this file covers the raw flip,
 * including its failure semantics (leave permissionMode unchanged on rejection).
 */

import { describe, it, expect, vi } from 'vitest';
import { togglePlanMode } from './plan-mode-toggle.js';
import type { SessionStats, SlashContext } from './slash/types.js';
import type { PermissionMode } from '../agent/types/sdk-types.js';

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
    permissionMode: 'default',
    ...overrides,
  };
}

interface FakeSession {
  setPermissionMode: ReturnType<typeof vi.fn>;
  getPrePlanMode: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: {
  stats: SessionStats;
  setPermissionMode?: ReturnType<typeof vi.fn>;
  prePlanMode?: PermissionMode;
}): { ctx: SlashContext; sess: FakeSession; lines: string[] } {
  const lines: string[] = [];
  const sess: FakeSession = {
    setPermissionMode: opts.setPermissionMode ?? vi.fn().mockResolvedValue(undefined),
    // The session captures the pre-plan mode; `/plan off` restores it. Defaults
    // to undefined → helper falls back to 'default' (the original behavior).
    getPrePlanMode: vi.fn().mockReturnValue(opts.prePlanMode),
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

describe('togglePlanMode', () => {
  it('flips default → plan and emits ON copy', async () => {
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await togglePlanMode(ctx, true);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(stats.permissionMode).toBe('plan');
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('plan mode on');
  });

  it('flips plan → default and emits OFF copy', async () => {
    const stats = makeStats({ permissionMode: 'plan' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await togglePlanMode(ctx, false);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.permissionMode).toBe('default');
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('plan mode off');
    expect(joined).toContain('default permissions restored');
  });

  it('toggles based on current mode when no explicit desired is passed', async () => {
    const stats = makeStats({ permissionMode: 'plan' });
    const { ctx, sess } = makeCtx({ stats });

    await togglePlanMode(ctx);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.permissionMode).toBe('default');
  });

  it('restores the pre-plan mode (bypass) on exit instead of forcing default', async () => {
    const stats = makeStats({ permissionMode: 'plan' });
    const { ctx, sess, lines } = makeCtx({ stats, prePlanMode: 'bypassPermissions' });

    await togglePlanMode(ctx, false);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(stats.permissionMode).toBe('bypassPermissions');
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('plan mode off');
    expect(joined).toContain('bypass restored');
  });

  it('restores the pre-plan mode (acceptEdits) on exit', async () => {
    const stats = makeStats({ permissionMode: 'plan' });
    const { ctx, sess, lines } = makeCtx({ stats, prePlanMode: 'acceptEdits' });

    await togglePlanMode(ctx, false);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(stats.permissionMode).toBe('acceptEdits');
    expect(lines.join('\n').toLowerCase()).toContain('accept-edits restored');
  });

  it('restores a non-ring mode (dontAsk) with an accurate status line', async () => {
    const stats = makeStats({ permissionMode: 'plan' });
    const { ctx, sess, lines } = makeCtx({ stats, prePlanMode: 'dontAsk' });

    await togglePlanMode(ctx, false);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('dontAsk');
    expect(stats.permissionMode).toBe('dontAsk');
    const joined = lines.join('\n').toLowerCase();
    // Must NOT mislabel as "default permissions restored".
    expect(joined).toContain('previous mode restored');
    expect(joined).not.toContain('default permissions restored');
  });

  it('falls back to default on exit when no pre-plan mode was captured', async () => {
    const stats = makeStats({ permissionMode: 'plan' });
    const { ctx, sess } = makeCtx({ stats }); // prePlanMode undefined

    await togglePlanMode(ctx, false);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.permissionMode).toBe('default');
  });

  it('entering plan flips to plan and never consults getPrePlanMode (only exit restores)', async () => {
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, sess } = makeCtx({ stats, prePlanMode: 'bypassPermissions' });

    await togglePlanMode(ctx, true);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(stats.permissionMode).toBe('plan');
    expect(sess.getPrePlanMode).not.toHaveBeenCalled();
  });

  it('leaves permissionMode unchanged and surfaces an error when setPermissionMode rejects', async () => {
    // The provider's query handle can reject (closing or torn down). The
    // helper must NOT advance stats.permissionMode — callers (e.g. /plan off) read
    // it back to decide whether to seed a follow-up turn.
    const setPermissionMode = vi.fn().mockRejectedValue(new Error('boom'));
    const stats = makeStats({ permissionMode: 'plan' });
    const { ctx, lines } = makeCtx({ stats, setPermissionMode });

    await togglePlanMode(ctx, false);

    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.permissionMode).toBe('plan');
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });
});
