/**
 * Tests for the /sh slash command — list/show/kill subcommands plus
 * unavailable-session fallback.
 *
 * The underlying ShellPassthrough + ShellJobRegistry are exhaustively
 * tested elsewhere; this file verifies only the /sh argument-parsing and
 * output formatting layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShellPassthrough } from '../../commands/interactive/shell-passthrough.js';
import { shCmd, setShellPassthrough } from './sh.js';
import type { SlashContext, SessionStats } from '../types.js';

function makeStats(): SessionStats {
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
  };
}

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: makeStats(),
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

function newPassthrough(): ShellPassthrough {
  return new ShellPassthrough({
    writeLine: () => {},
    getCwd: () => undefined,
  });
}

// Strip ANSI escapes from logged lines so assertions can match plain text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
function clean(s: string): string {
  return s.replace(ANSI, '');
}

describe('/sh slash command', () => {
  beforeEach(() => {
    // Reset the module-level ref between tests so an "unavailable" test
    // doesn't inherit a prior test's passthrough.
    setShellPassthrough(undefined as unknown as ShellPassthrough);
  });

  it('reports unavailable when no passthrough is wired', async () => {
    const { ctx, lines } = makeCtx();
    const result = await shCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('ERROR:') && l.includes('not available'))).toBe(true);
  });

  it('list (no args) on empty session prints a hint', async () => {
    setShellPassthrough(newPassthrough());
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, '');
    const text = lines.map(clean).join('\n');
    expect(text).toMatch(/no shell jobs/);
  });

  it('list shows the table with one running job', async () => {
    const pt = newPassthrough();
    setShellPassthrough(pt);
    // Start a bg job that runs long enough to still be 'running' when we list.
    pt.registry.start({ command: 'sleep 5', mode: 'background' });
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, 'list');
    const text = lines.map(clean).join('\n');
    expect(text).toContain('sh-1');
    expect(text).toContain('running');
    expect(text).toContain('sleep 5');
    // Cleanup so the test process doesn't linger.
    pt.drainOnExit();
  });

  it('show <id> prints command + captured output + footer', async () => {
    const pt = newPassthrough();
    setShellPassthrough(pt);
    const { job, handle } = pt.registry.start({ command: 'echo show-me', mode: 'foreground' });
    await handle.promise;
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, `show ${job.id}`);
    const text = lines.map(clean).join('\n');
    expect(text).toContain('$ echo show-me');
    expect(text).toContain('show-me');
    expect(text).toContain('exit 0');
  });

  it('show accepts bare digits as a shortcut', async () => {
    const pt = newPassthrough();
    setShellPassthrough(pt);
    const { handle } = pt.registry.start({ command: 'echo first', mode: 'foreground' });
    await handle.promise;
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, 'show 1');
    expect(lines.map(clean).join('\n')).toContain('first');
  });

  it('show on unknown id surfaces an error', async () => {
    setShellPassthrough(newPassthrough());
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, 'show sh-999');
    expect(lines.some((l) => l.startsWith('ERROR:') && l.includes('not found'))).toBe(true);
  });

  it('show without an id surfaces usage', async () => {
    setShellPassthrough(newPassthrough());
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, 'show');
    expect(lines.some((l) => l.startsWith('INFO:') && l.includes('Usage'))).toBe(true);
  });

  it('kill <id> terminates a running job', async () => {
    const pt = newPassthrough();
    setShellPassthrough(pt);
    const { job, handle } = pt.registry.start({ command: 'sleep 5', mode: 'background' });
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, `kill ${job.id}`);
    // Wait for the kill to land.
    await handle.promise;
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('Killed'))).toBe(true);
    expect(job.status).toBe('killed');
  });

  it('kill <id> on a completed job warns instead of erroring', async () => {
    const pt = newPassthrough();
    setShellPassthrough(pt);
    const { job, handle } = pt.registry.start({ command: 'echo done', mode: 'foreground' });
    await handle.promise;
    // Yield a tick so the registry's complete handler runs.
    await new Promise((r) => setImmediate(r));
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, `kill ${job.id}`);
    expect(lines.some((l) => l.startsWith('WARN:') && l.includes('not running'))).toBe(true);
  });

  it('kill on unknown id surfaces error', async () => {
    setShellPassthrough(newPassthrough());
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, 'kill sh-999');
    expect(lines.some((l) => l.startsWith('ERROR:') && l.includes('not found'))).toBe(true);
  });

  it('unknown subcommand warns and lists alternatives', async () => {
    setShellPassthrough(newPassthrough());
    const { ctx, lines } = makeCtx();
    await shCmd.handler(ctx, 'zoltar');
    expect(lines.some((l) => l.startsWith('WARN:') && l.includes('zoltar'))).toBe(true);
  });
});
