/**
 * Tests for the /thinking slash command.
 *
 * The command mutates `ctx.stats.thinkingUi` (a shared `SessionStats` field)
 * to toggle the thinking-display mode mid-session. Tests assert:
 *   1. no args → current mode is printed
 *   2. valid mode → stats mutated + success confirmation printed
 *   3. invalid mode → error surfaced, stats NOT mutated
 *   4. alias `/thinking-ui` resolves to the same command
 *   5. effect is on the next turn (stats is the shared object, not a copy)
 */

import { describe, it, expect, vi } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';
import { thinkingCmd } from './thinking.js';

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
    thinkingUi: 'live',
    ...overrides,
  };
}

function makeCtx(stats?: SessionStats): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
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
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

describe('/thinking slash command', () => {
  it('prints current mode when no args given', async () => {
    const { ctx, lines } = makeCtx(makeStats({ thinkingUi: 'summary' }));
    const result = await thinkingCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('INFO:') && l.includes('summary'))).toBe(true);
  });

  it('defaults to "live" when stats.thinkingUi is undefined', async () => {
    const { ctx, lines } = makeCtx(makeStats({ thinkingUi: undefined }));
    const result = await thinkingCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('INFO:') && l.includes('live'))).toBe(true);
  });

  it('switches to summary and mutates stats', async () => {
    const stats = makeStats({ thinkingUi: 'live' });
    const { ctx, lines } = makeCtx(stats);
    const result = await thinkingCmd.handler(ctx, 'summary');
    expect(result).toBe('continue');
    expect(stats.thinkingUi).toBe('summary');
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('summary'))).toBe(true);
  });

  it('switches to off and mutates stats', async () => {
    const stats = makeStats({ thinkingUi: 'live' });
    const { ctx, lines } = makeCtx(stats);
    const result = await thinkingCmd.handler(ctx, 'off');
    expect(result).toBe('continue');
    expect(stats.thinkingUi).toBe('off');
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('off'))).toBe(true);
  });

  it('switches to digest and mutates stats', async () => {
    const stats = makeStats({ thinkingUi: 'live' });
    const { ctx, lines } = makeCtx(stats);
    const result = await thinkingCmd.handler(ctx, 'digest');
    expect(result).toBe('continue');
    expect(stats.thinkingUi).toBe('digest');
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('digest'))).toBe(true);
  });

  it('switches back to live from summary', async () => {
    const stats = makeStats({ thinkingUi: 'summary' });
    const { ctx, lines } = makeCtx(stats);
    const result = await thinkingCmd.handler(ctx, 'live');
    expect(result).toBe('continue');
    expect(stats.thinkingUi).toBe('live');
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('live'))).toBe(true);
  });

  it('rejects invalid mode without mutating stats', async () => {
    const stats = makeStats({ thinkingUi: 'live' });
    const { ctx, lines } = makeCtx(stats);
    const result = await thinkingCmd.handler(ctx, 'verbose');
    expect(result).toBe('continue');
    expect(stats.thinkingUi).toBe('live'); // unchanged
    expect(lines.some((l) => l.startsWith('WARN:') && l.includes('Invalid mode'))).toBe(true);
  });

  it('trims and lowercases the argument', async () => {
    const stats = makeStats({ thinkingUi: 'live' });
    const { ctx } = makeCtx(stats);
    const result = await thinkingCmd.handler(ctx, '  SUMMARY  ');
    expect(result).toBe('continue');
    expect(stats.thinkingUi).toBe('summary');
  });

  it('exposes metadata for autocomplete', () => {
    expect(thinkingCmd.name).toBe('/thinking');
    expect(thinkingCmd.aliases).toContain('/thinking-ui');
    expect(thinkingCmd.flags).toEqual(['summary', 'live', 'digest', 'off']);
    expect(thinkingCmd.summary).toBeTruthy();
    expect(thinkingCmd.hint).toBeTruthy();
  });
});