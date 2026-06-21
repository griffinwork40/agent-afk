/**
 * Unit tests for the Shift+Tab permission-mode cycle.
 *
 * `cyclePermissionMode` advances the ring default → plan → bypassPermissions →
 * default. AFK (`autonomous`) is excluded from the ring: if the session is
 * already in autonomous, the cycle exits it via `toggleAfkMode(ctx, false)`
 * (mocked here) rather than stepping to a ring mode — never entering AFK on a
 * keypress. plan/bypass/default transitions are pure setPermissionMode flips
 * with the same rejection contract as togglePlanMode (leave stats unchanged +
 * surface error).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cyclePermissionMode, PERMISSION_CYCLE } from './permission-mode-cycle.js';
import { toggleAfkMode } from './afk-mode-toggle.js';
import type { SessionStats, SlashContext } from './slash/types.js';

// AFK's heavy enter/exit machinery is out of scope here — stub the helper so we
// can assert the cycle DELEGATES the autonomous-exit to it (rather than firing a
// raw setPermissionMode that would leak the abort-watcher / strand presence).
vi.mock('./afk-mode-toggle.js', () => ({
  toggleAfkMode: vi.fn(async () => {}),
}));

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
    vi.mocked(toggleAfkMode).mockClear();
  });

  it('ring constant excludes autonomous (AFK stays on /afk)', () => {
    expect(PERMISSION_CYCLE).toEqual(['default', 'plan', 'bypassPermissions']);
    expect(PERMISSION_CYCLE as readonly string[]).not.toContain('autonomous');
  });

  it('default → plan and emits plan ON copy', async () => {
    const stats = makeStats({ permissionMode: 'default' });
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

  it('bypassPermissions → default (wraps) and emits default copy', async () => {
    const stats = makeStats({ permissionMode: 'bypassPermissions' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await cyclePermissionMode(ctx);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.permissionMode).toBe('default');
    expect(ctx.ui.repaintStatusLine).toHaveBeenCalled();
    // Wrapping out of bypass is a pure ring step — it must NOT touch the AFK
    // teardown helper (that path is reserved for `autonomous`).
    expect(toggleAfkMode).not.toHaveBeenCalled();
    // Pin the distinctive default-landing copy ("… approval prompts restored."),
    // not merely the substring "default" (which also appears in the marker glyph
    // and would match almost any output).
    const out = lines.join('\n').toLowerCase();
    expect(out).toContain('default');
    expect(out).toContain('restored');
  });

  it('autonomous (AFK) → exits via toggleAfkMode(ctx, false), never a raw setPermissionMode', async () => {
    const stats = makeStats({ permissionMode: 'autonomous' });
    const { ctx, sess } = makeCtx({ stats });

    await cyclePermissionMode(ctx);

    expect(toggleAfkMode).toHaveBeenCalledWith(ctx, false);
    expect(sess.setPermissionMode).not.toHaveBeenCalled();
  });

  it('out-of-ring mode (e.g. acceptEdits) falls back to default', async () => {
    const stats = makeStats({ permissionMode: 'acceptEdits' });
    const { ctx, sess } = makeCtx({ stats });

    await cyclePermissionMode(ctx);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.permissionMode).toBe('default');
    expect(toggleAfkMode).not.toHaveBeenCalled();
  });

  it('leaves permissionMode unchanged and surfaces an error when setPermissionMode rejects', async () => {
    // Mirrors togglePlanMode's failure contract: a provider query-handle
    // rejection must NOT advance stats.permissionMode (the prompt/status line
    // read it back).
    const setPermissionMode = vi.fn().mockRejectedValue(new Error('boom'));
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, lines } = makeCtx({ stats, setPermissionMode });

    await cyclePermissionMode(ctx);

    expect(setPermissionMode).toHaveBeenCalledWith('plan');
    expect(stats.permissionMode).toBe('default');
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });
});
