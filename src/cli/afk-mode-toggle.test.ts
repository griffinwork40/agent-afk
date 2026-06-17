/**
 * Unit tests for the AFK-mode toggle helper.
 *
 * `toggleAfkMode` flips the session permission mode ('autonomous' <-> 'default'),
 * mirrors the result onto `stats.permissionMode`, resets the per-session push
 * budget on turn-ON, and preflights Telegram config (warns but still enters AFK
 * mode when unconfigured). Mirrors plan-mode-toggle's failure semantics: leave
 * permissionMode unchanged on a setPermissionMode rejection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable Telegram-config state the mocks read.
let mockToken: string | undefined = 'bot-token';
let mockTargets: number[] = [123456];

vi.mock('../config/env.js', () => ({
  get env() {
    return { TELEGRAM_BOT_TOKEN: mockToken };
  },
}));
vi.mock('../telegram/notify-routing.js', () => ({
  resolveConfiguredNotifyTargets: () => mockTargets,
}));
const resetAfkPushBudget = vi.fn();
vi.mock('./commands/interactive/afk-push.js', () => ({
  resetAfkPushBudget: () => resetAfkPushBudget(),
}));

import { toggleAfkMode } from './afk-mode-toggle.js';
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
    permissionMode: 'default',
    ...overrides,
  };
}

function makeCtx(opts: {
  stats: SessionStats;
  setPermissionMode?: ReturnType<typeof vi.fn>;
}): { ctx: SlashContext; sess: { setPermissionMode: ReturnType<typeof vi.fn> }; lines: string[] } {
  const lines: string[] = [];
  const sess = {
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

describe('toggleAfkMode', () => {
  beforeEach(() => {
    mockToken = 'bot-token';
    mockTargets = [123456];
    resetAfkPushBudget.mockClear();
  });

  it('flips default → autonomous and emits ON copy', async () => {
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await toggleAfkMode(ctx, true);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('autonomous');
    expect(stats.permissionMode).toBe('autonomous');
    expect(lines.join('\n').toLowerCase()).toContain('afk mode on');
  });

  it('resets the per-session push budget on turn-ON', async () => {
    const { ctx } = makeCtx({ stats: makeStats() });
    await toggleAfkMode(ctx, true);
    expect(resetAfkPushBudget).toHaveBeenCalledTimes(1);
  });

  it('flips autonomous → default and emits OFF copy', async () => {
    const stats = makeStats({ permissionMode: 'autonomous' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await toggleAfkMode(ctx, false);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.permissionMode).toBe('default');
    expect(lines.join('\n').toLowerCase()).toContain('afk mode off');
  });

  it('warns but STILL enters AFK mode when Telegram is unconfigured', async () => {
    mockToken = undefined;
    mockTargets = [];
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, lines } = makeCtx({ stats });

    await toggleAfkMode(ctx, true);

    // Mode still flips — gate + posture apply regardless of Telegram.
    expect(stats.permissionMode).toBe('autonomous');
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('telegram is not configured');
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });

  it('does NOT warn about Telegram when fully configured', async () => {
    const { ctx, lines } = makeCtx({ stats: makeStats() });
    await toggleAfkMode(ctx, true);
    expect(lines.join('\n').toLowerCase()).not.toContain('telegram is not configured');
  });

  it('leaves permissionMode unchanged and surfaces an error when setPermissionMode rejects', async () => {
    const setPermissionMode = vi.fn().mockRejectedValue(new Error('boom'));
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, lines } = makeCtx({ stats, setPermissionMode });

    await toggleAfkMode(ctx, true);

    expect(setPermissionMode).toHaveBeenCalledWith('autonomous');
    expect(stats.permissionMode).toBe('default');
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });
});
