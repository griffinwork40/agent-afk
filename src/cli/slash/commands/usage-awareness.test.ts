/**
 * Tests for the /usage-awareness slash command.
 *
 * The command toggles whether the model sees subscription usage info and
 * persists the setting to afk.config.json. Tests assert:
 *   1. no args → current state is printed
 *   2. /usage-awareness on  → stats mutated + success + repaintStatusLine called
 *   3. /usage-awareness off → stats mutated + success + repaintStatusLine called
 *   4. invalid arg → warning emitted, stats NOT mutated
 *   5. config persistence is attempted (best-effort)
 *   6. alias /ua resolves to the same command
 *   7. command metadata is correct
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';
import { usageAwarenessCmd } from './usage-awareness.js';
import { resetUsageAwarenessForTests } from '../../../agent/usage/usage-awareness-toggle.js';

// Mock config persistence so tests don't touch the filesystem.
vi.mock('../../../config/mutate.js', () => ({
  setConfigValue: vi.fn().mockResolvedValue(undefined),
}));

import { setConfigValue } from '../../../config/mutate.js';

afterEach(() => {
  resetUsageAwarenessForTests();
  vi.clearAllMocks();
});

function makeStats(overrides?: Partial<SessionStats>): SessionStats {
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

function makeCtx(stats?: SessionStats): { ctx: SlashContext; lines: string[]; repaint: ReturnType<typeof vi.fn> } {
  const lines: string[] = [];
  const repaint = vi.fn();
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: stats ?? makeStats(),
    out: {
      line: (t = ''): void => { lines.push(`LINE:${t}`); },
      raw: (t): void => { lines.push(`RAW:${t}`); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: repaint },
  };
  return { ctx, lines, repaint };
}

describe('/usage-awareness slash command', () => {
  it('prints current state (on) when no args given', async () => {
    const { ctx, lines } = makeCtx(makeStats({ usageAwareness: undefined })); // defaults to on
    const result = await usageAwarenessCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('INFO:') && l.includes('on'))).toBe(true);
  });

  it('prints current state (off) when usageAwareness is false', async () => {
    const { ctx, lines } = makeCtx(makeStats({ usageAwareness: false }));
    const result = await usageAwarenessCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('INFO:') && l.includes('off'))).toBe(true);
  });

  it('sets usage awareness off and mutates stats', async () => {
    const stats = makeStats({ usageAwareness: undefined });
    const { ctx, lines, repaint } = makeCtx(stats);
    const result = await usageAwarenessCmd.handler(ctx, 'off');
    expect(result).toBe('continue');
    expect(stats.usageAwareness).toBe(false);
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('off'))).toBe(true);
    expect(repaint).toHaveBeenCalledOnce();
  });

  it('sets usage awareness on and mutates stats', async () => {
    const stats = makeStats({ usageAwareness: false });
    const { ctx, lines, repaint } = makeCtx(stats);
    const result = await usageAwarenessCmd.handler(ctx, 'on');
    expect(result).toBe('continue');
    expect(stats.usageAwareness).toBe(true);
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('on'))).toBe(true);
    expect(repaint).toHaveBeenCalledOnce();
  });

  it('persists to config when toggled', async () => {
    const { ctx } = makeCtx();
    await usageAwarenessCmd.handler(ctx, 'off');
    expect(setConfigValue).toHaveBeenCalledWith('tools.usageAwareness', false);
  });

  it('rejects invalid arg without mutating stats', async () => {
    const stats = makeStats({ usageAwareness: undefined });
    const { ctx, lines, repaint } = makeCtx(stats);
    const result = await usageAwarenessCmd.handler(ctx, 'maybe');
    expect(result).toBe('continue');
    expect(stats.usageAwareness).toBeUndefined(); // unchanged
    expect(lines.some((l) => l.startsWith('WARN:'))).toBe(true);
    expect(repaint).not.toHaveBeenCalled();
  });

  it('trims and lowercases the argument', async () => {
    const stats = makeStats({ usageAwareness: undefined });
    const { ctx } = makeCtx(stats);
    const result = await usageAwarenessCmd.handler(ctx, '  OFF  ');
    expect(result).toBe('continue');
    expect(stats.usageAwareness).toBe(false);
  });

  it('exposes correct metadata', () => {
    expect(usageAwarenessCmd.name).toBe('/usage-awareness');
    expect(usageAwarenessCmd.aliases).toContain('/ua');
    expect(usageAwarenessCmd.flags).toEqual(['on', 'off']);
    expect(usageAwarenessCmd.summary).toBeTruthy();
    expect(usageAwarenessCmd.hint).toBeTruthy();
  });
});
