/**
 * Tests for the /save slash command after the naming reframe.
 *
 * Key contract: /save <name> sets the session NAME (metadata) and always
 * writes the single <sessionId>.json sidecar — it never forks a <name>.json
 * duplicate the way the old overrideId-as-filename behavior did.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveCmd } from './save.js';
import { loadSession, listSessions } from '../../session-store.js';
import type { SlashContext, SessionStats } from '../types.js';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-save-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
});

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

function makeCtx(stats: SessionStats): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: {} as SlashContext['session'],
    stats,
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines };
}

describe('/save', () => {
  it('warns and does nothing when there are no turns', async () => {
    const { ctx, lines } = makeCtx(makeStats({ totalTurns: 0 }));
    const result = await saveCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => /WARN:.*Nothing to save/i.test(l))).toBe(true);
    expect(listSessions()).toEqual([]);
  });

  it('saves to <sessionId>.json with no arg', async () => {
    const stats = makeStats({ totalTurns: 1, sessionId: 'sdk-plain' });
    const { ctx, lines } = makeCtx(stats);
    await saveCmd.handler(ctx, '');
    expect(lines.some((l) => /SUCCESS:.*Saved/i.test(l))).toBe(true);
    expect(loadSession('sdk-plain')).toBeDefined();
  });

  it('/save <name> sets the name as metadata and does NOT create a <name>.json file', async () => {
    const stats = makeStats({ totalTurns: 1, sessionId: 'sdk-savename' });
    const { ctx } = makeCtx(stats);
    await saveCmd.handler(ctx, 'My Report');

    expect(stats.name).toBe('my-report');
    // Exactly one sidecar, keyed by sessionId.
    const list = listSessions();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe('sdk-savename');
    expect(loadSession('sdk-savename')!.name).toBe('my-report');
    // No file literally named after the slug.
    expect(loadSession('my-report')).toBeUndefined();
  });

  it('warns on an invalid name but still saves under the existing/auto name', async () => {
    const stats = makeStats({ totalTurns: 1, sessionId: 'sdk-keepname', name: 'prior-name' });
    const { ctx, lines } = makeCtx(stats);
    await saveCmd.handler(ctx, '###');
    expect(stats.name).toBe('prior-name');
    expect(lines.some((l) => /WARN:.*Ignoring invalid name/i.test(l))).toBe(true);
    expect(loadSession('sdk-keepname')!.name).toBe('prior-name');
  });
});
