/**
 * Tests for the /transcript slash command — specifically the TTY/pager branch.
 *
 * Regression guard for the "super glitchy pager" bug: /transcript spawns the
 * pager with `stdio: 'inherit'`, so the pager reads the SAME stdin fd the REPL
 * owns. Unless the command (1) suspends the compositor input surface AND
 * (2) pauses Node's stdin before the spawn — and restores both on child exit —
 * the REPL reader and the pager race for every keystroke and split it between
 * them, corrupting pager navigation.
 *
 * These tests assert the suspend+pause-before-spawn / resume+restore-on-exit
 * contract. The non-pager (non-TTY) and empty-session branches are also
 * covered. Transcript formatting itself (renderMarkdownToTerminal, palette) is
 * exercised for real — it is pure and tested elsewhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SlashContext, SessionStats } from '../types.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { transcriptCmd } from './transcript.ts';

const mockSpawn = vi.mocked(spawn);

function makeStats(turnCount = 1): SessionStats {
  const turns = Array.from({ length: turnCount }, (_, i) => ({
    timestamp: Date.now(),
    user: `q${i}`,
    assistant: `a${i}`,
    durationMs: 100,
  }));
  return {
    totalTurns: turnCount,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: turns as unknown as SessionStats['turns'],
    model: 'sonnet',
    permissionMode: 'default',
  } as unknown as SessionStats;
}

function makeCtx(turnCount = 1): {
  ctx: SlashContext;
  lines: string[];
  suspendInput: ReturnType<typeof vi.fn>;
  resumeInput: ReturnType<typeof vi.fn>;
} {
  const lines: string[] = [];
  const suspendInput = vi.fn();
  const resumeInput = vi.fn();
  const compositor = { suspendInput, resumeInput };
  const ctx = {
    session: { current: {} },
    stats: makeStats(turnCount),
    out: {
      line: (t = ''): void => { lines.push(`LINE:${t}`); },
      raw: (t: string): void => { lines.push(`RAW:${t}`); },
      success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
      info: (t: string): void => { lines.push(`INFO:${t}`); },
      warn: (t: string): void => { lines.push(`WARN:${t}`); },
      error: (t: string): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    getCompositor: () => compositor,
  } as unknown as SlashContext;
  return { ctx, lines, suspendInput, resumeInput };
}

/** Poll until the (mocked) pager spawn has been invoked, flushing the await fs.writeFile. */
async function flushUntilSpawn(): Promise<void> {
  for (let i = 0; i < 200 && mockSpawn.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('/transcript slash command — pager TTY handoff', () => {
  let origIsTTY: boolean | undefined;
  let pauseSpy: ReturnType<typeof vi.spyOn>;
  let resumeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    origIsTTY = process.stdout.isTTY;
    // Never actually pause/resume the test runner's stdin.
    pauseSpy = vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    resumeSpy = vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  });

  afterEach(() => {
    (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
    vi.restoreAllMocks();
  });

  it('suspends compositor input AND pauses stdin BEFORE spawning the pager, then restores on exit', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    const child = new EventEmitter() as EventEmitter & { stdin?: unknown };
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const { ctx, suspendInput, resumeInput } = makeCtx();
    const p = transcriptCmd.handler(ctx);
    await flushUntilSpawn();

    // Pre-spawn: input surface suspended + stdin paused; restore NOT yet run.
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(suspendInput).toHaveBeenCalledOnce();
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(resumeInput).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();

    // Pager inherits the terminal.
    const call = mockSpawn.mock.calls[0]!;
    const args = call[1] as string[];
    const opts = call[2] as { stdio?: string };
    expect(opts.stdio).toBe('inherit');
    expect(args.at(-1)).toContain('afk-transcript-');

    // Child exits → restore stdin + compositor input.
    child.emit('exit', 0);
    await expect(p).resolves.toBe('continue');
    expect(resumeSpy).toHaveBeenCalledOnce();
    expect(resumeInput).toHaveBeenCalledOnce();
  });

  it('restores the input surface (and falls back to inline output) when the pager errors', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    const child = new EventEmitter();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const { ctx, lines, suspendInput, resumeInput } = makeCtx();
    const p = transcriptCmd.handler(ctx);
    await flushUntilSpawn();
    expect(suspendInput).toHaveBeenCalledOnce();

    child.emit('error', new Error('spawn less ENOENT'));
    await expect(p).resolves.toBe('continue');

    // Restored exactly once, and the transcript was dumped inline as a fallback.
    expect(resumeInput).toHaveBeenCalledOnce();
    expect(resumeSpy).toHaveBeenCalledOnce();
    expect(lines.some((l) => l.startsWith('RAW:'))).toBe(true);
  });

  it('does not spawn a pager or touch stdin on a non-TTY surface', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    const { ctx, lines, suspendInput } = makeCtx();

    const res = await transcriptCmd.handler(ctx);

    expect(res).toBe('continue');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(suspendInput).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith('RAW:'))).toBe(true);
  });

  it('reports an empty session without spawning or suspending', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    const { ctx, lines, suspendInput } = makeCtx(0);

    const res = await transcriptCmd.handler(ctx);

    expect(res).toBe('continue');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(suspendInput).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('No turns yet'))).toBe(true);
  });
});
