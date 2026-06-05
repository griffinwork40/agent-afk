/**
 * Tests for the /fork slash command.
 *
 * Points HOME at a tmp dir so the forked sidecar never touches the real
 * ~/.afk/state/sessions. Verifies the always-succeeds contract: a new
 * independent session is written, the resume command is surfaced, and the
 * live session is left untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { forkCmd, forkSpawnLines } from './fork.js';
import { listSessions, loadSession } from '../../session-store.js';
import { createSessionStats, recordTurn } from '../session-stats.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { SpawnOutcome } from '../../terminal-spawn/index.js';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-fork-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
});

function makeCtx(stats: SessionStats): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const push = (t = ''): void => { lines.push(t); };
  const ctx: SlashContext = {
    session: { current: { sessionId: stats.sessionId } as unknown as SlashContext['session']['current'] } as SlashContext['session'],
    stats,
    out: { line: push, raw: push, success: push, info: push, warn: push, error: push },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines };
}

describe('/fork', () => {
  it('refuses to fork an empty session', async () => {
    const stats = createSessionStats('sonnet');
    const { ctx, lines } = makeCtx(stats);

    const result = await forkCmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(lines.join('\n')).toContain('Nothing to fork');
    expect(listSessions()).toHaveLength(0); // no sidecar written
  });

  it('writes an independent fork and surfaces the resume command', async () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'design a cache', 'here is a cache', { sessionId: 'parent-sdk-id' });
    const { ctx, lines } = makeCtx(stats);

    const result = await forkCmd.handler(ctx, '');
    expect(result).toBe('continue');

    const entries = listSessions();
    expect(entries).toHaveLength(1);
    const forkId = entries[0]!.id;

    const forked = loadSession(forkId);
    expect(forked!.sessionId).not.toBe('parent-sdk-id'); // fresh id
    expect(forked!.forkedFrom).toBe('parent-sdk-id');
    expect(forked!.turns).toHaveLength(1);

    const out = lines.join('\n');
    expect(out).toContain('Forked');
    expect(out).toContain('--resume');
    expect(out).toContain(forkId);
    // Honesty line about what is NOT carried over.
    expect(out).toContain('not forked');
  });

  it('is registered under /fork with a /branch alias', () => {
    expect(forkCmd.name).toBe('/fork');
    expect(forkCmd.aliases).toContain('/branch');
  });

  it('leaves the live session untouched (no resume swap)', async () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'q', 'a', { sessionId: 'live-id' });
    const { ctx } = makeCtx(stats);

    await forkCmd.handler(ctx, '');

    // The fork never swaps the running session: its sessionId is unchanged.
    expect(ctx.stats.sessionId).toBe('live-id');
  });
});

describe('forkSpawnLines', () => {
  const cmd = 'afk interactive --resume fork-1';

  it('announces a new tab when spawned with tab capability', () => {
    const spawn: SpawnOutcome = { spawned: true, kind: 'ghostty', capability: 'tab' };
    const out = forkSpawnLines(spawn, cmd, false).join('\n');
    expect(out).toContain('new Ghostty tab');
    expect(out).toContain('Or run it yourself');
    expect(out).toContain(cmd);
    expect(out).not.toContain('copied to clipboard');
  });

  it('announces a new window when spawned with window capability', () => {
    const spawn: SpawnOutcome = { spawned: true, kind: 'apple-terminal', capability: 'window' };
    const out = forkSpawnLines(spawn, cmd, false).join('\n');
    expect(out).toContain('new Terminal window');
  });

  it('gives a VS Code-specific hint when its integrated terminal cannot be opened', () => {
    const spawn: SpawnOutcome = { spawned: false, kind: 'vscode', capability: 'none', reason: 'no-tab-mechanism' };
    const out = forkSpawnLines(spawn, cmd, true).join('\n');
    expect(out).toContain("VS Code's integrated terminal");
    expect(out).toContain('copied to clipboard');
  });

  it('falls back to a plain continue line for generic non-spawn cases', () => {
    const spawn: SpawnOutcome = { spawned: false, kind: 'unknown', capability: 'none', reason: 'no-tab-mechanism' };
    const out = forkSpawnLines(spawn, cmd, false).join('\n');
    expect(out).toContain('Continue the fork with');
    expect(out).toContain(cmd);
  });

  it('always includes the "not forked" honesty note', () => {
    const spawn: SpawnOutcome = { spawned: true, kind: 'tmux', capability: 'tab' };
    expect(forkSpawnLines(spawn, cmd, false).join('\n')).toContain('not forked');
  });
});
