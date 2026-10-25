/**
 * Tests for the /name slash command.
 *
 * Points HOME at a tmp dir so saves don't touch real ~/.afk/state/sessions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { nameCmd } from './name.js';
import { loadSession } from '../../session-store.js';
import type { SlashContext, SessionStats } from '../types.js';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-name-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    permissionMode: 'default',
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

describe('/name', () => {
  it('reports "no name set" when called with no arg on an unnamed session', async () => {
    const { ctx, lines } = makeCtx(makeStats());
    const result = await nameCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => /INFO:.*No name set/i.test(l))).toBe(true);
  });

  it('shows the current name when called with no arg on a named session', async () => {
    const { ctx, lines } = makeCtx(makeStats({ name: 'my-session' }));
    await nameCmd.handler(ctx, '');
    expect(lines.some((l) => l.includes('my-session'))).toBe(true);
  });

  it('slugifies the arg, sets stats.name, and persists when the session has turns', async () => {
    const stats = makeStats({ totalTurns: 1, sessionId: 'sdk-named' });
    const { ctx, lines } = makeCtx(stats);
    const result = await nameCmd.handler(ctx, 'My Cool Session');
    expect(result).toBe('continue');
    expect(stats.name).toBe('cool-session');
    expect(lines.some((l) => /SUCCESS:.*Named/i.test(l))).toBe(true);
    // Persisted to the single <sessionId>.json sidecar.
    expect(loadSession('sdk-named')?.name).toBe('cool-session');
  });

  it('sets the name without saving when the session has no turns yet', async () => {
    const stats = makeStats({ totalTurns: 0, sessionId: 'sdk-pending' });
    const { ctx, lines } = makeCtx(stats);
    await nameCmd.handler(ctx, 'pre-turn-name');
    expect(stats.name).toBe('pre-turn-name');
    expect(lines.some((l) => /saves on first turn/i.test(l))).toBe(true);
    // Nothing written yet.
    expect(loadSession('sdk-pending')).toBeUndefined();
  });

  it('rejects an invalid (punctuation-only) name and leaves stats.name unchanged', async () => {
    const stats = makeStats({ totalTurns: 1, sessionId: 'sdk-invalid', name: 'keep-me' });
    const { ctx, lines } = makeCtx(stats);
    await nameCmd.handler(ctx, '!!!');
    expect(stats.name).toBe('keep-me');
    expect(lines.some((l) => /WARN:.*Invalid name/i.test(l))).toBe(true);
  });

  it('REPL output is unchanged: slug plus the resume hint (no capabilities = REPL)', async () => {
    const stats = makeStats({ totalTurns: 1, sessionId: 'sdk-repl', model: 'haiku' });
    const { ctx, lines } = makeCtx(stats);
    await nameCmd.handler(ctx, 'Job queue research');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^SUCCESS:.*Named.*job-queue-research/);
    expect(lines[1]).toMatch(/Resume:.*afk interactive.*job-queue-research/);
    // Explicit REPL capabilities (consoleOutput) behave identically.
    const repl = makeCtx(makeStats({ totalTurns: 1, sessionId: 'sdk-repl2', model: 'haiku' }));
    repl.ctx.capabilities = new Set(['sessionControl', 'consoleOutput']);
    await nameCmd.handler(repl.ctx, 'Job queue research');
    expect(repl.lines).toEqual(lines.map((l) => l.replace('sdk-repl', 'sdk-repl2')));
  });

  it('web surface: echoes the name as typed, no terminal resume hint, slug stays the resume key', async () => {
    const stats = makeStats({ totalTurns: 1, sessionId: 'sdk-web', model: 'haiku' });
    const { ctx, lines } = makeCtx(stats);
    ctx.capabilities = new Set(['sessionControl', 'choose', 'progress']);
    await nameCmd.handler(ctx, 'Job queue research');
    expect(stats.name).toBe('job-queue-research');
    expect(stats.displayName).toBe('Job queue research');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Job queue research');
    expect(lines.join('\n')).not.toMatch(/afk interactive|Resume:/);
    const stored = loadSession('sdk-web');
    expect(stored?.name).toBe('job-queue-research');
    expect(stored?.displayName).toBe('Job queue research');
  });
});
