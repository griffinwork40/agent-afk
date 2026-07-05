/**
 * Tests for the /worktree slash command.
 *
 * Strategy: mock `runSweep` from the sweep engine module (the real engine
 * is exercised by `src/agent/worktree-sweep.test.ts`). Each test verifies
 * the slash's routing, argument parsing, formatting, and the "this session"
 * marker logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SlashContext, SessionStats } from '../types.js';

vi.mock('../../../agent/worktree-sweep.js', async () => {
  const actual = await vi.importActual<typeof import('../../../agent/worktree-sweep.js')>(
    '../../../agent/worktree-sweep.js',
  );
  return {
    ...actual,
    runSweep: vi.fn(),
  };
});

import { runSweep } from '../../../agent/worktree-sweep.js';
import { worktreeCmd } from './worktree.ts';

const mockRunSweep = runSweep as unknown as ReturnType<typeof vi.fn>;

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
    session: {} as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wt-slash-test-')));
  mockRunSweep.mockReset();
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe('/worktree slash command', () => {
  it('routes empty args to list', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [],
      removed: [],
      warnings: [],
      dryRun: true,
    });
    const { ctx, lines } = makeCtx();
    const result = await worktreeCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('INFO:No afk-managed'))).toBe(true);
    expect(mockRunSweep).toHaveBeenCalledOnce();
    expect(mockRunSweep.mock.calls[0]?.[0]?.dryRun).toBe(true);
  });

  it('list renders a row with a "this session" marker for the current PID', async () => {
    // Create a fake worktree directory with meta pointing at this PID.
    const wtPath = join(tmpRoot, 'wt-mine');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(
      join(wtPath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', pid: process.pid, createdAt: new Date().toISOString() }),
    );

    mockRunSweep.mockResolvedValue({
      candidates: [{ path: wtPath, verdict: 'active', owner: 'interactive', ageMs: 60_000 }],
      removed: [],
      warnings: [],
      dryRun: true,
    });

    const { ctx, lines } = makeCtx();
    const result = await worktreeCmd.handler(ctx, 'list');
    expect(result).toBe('continue');

    // Some line should contain a marker AND the path tail.
    const tail = wtPath.slice(-44);
    const hasMarker = lines.some((l) => l.includes('→') && l.includes(tail.slice(-20)));
    expect(hasMarker).toBe(true);
  });

  it('list does NOT add a marker for a different PID', async () => {
    const wtPath = join(tmpRoot, 'wt-other');
    await fs.mkdir(wtPath, { recursive: true });
    // PID that's almost certainly not us
    await fs.writeFile(
      join(wtPath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'interactive', pid: 999_999, createdAt: new Date().toISOString() }),
    );

    mockRunSweep.mockResolvedValue({
      candidates: [{ path: wtPath, verdict: 'active', owner: 'interactive', ageMs: 60_000 }],
      removed: [],
      warnings: [],
      dryRun: true,
    });

    const { ctx, lines } = makeCtx();
    await worktreeCmd.handler(ctx, 'list');

    const tail = wtPath.slice(-44);
    const rowsForThis = lines.filter((l) => l.includes(tail.slice(-20)));
    expect(rowsForThis.length).toBeGreaterThan(0);
    expect(rowsForThis.every((l) => !l.includes('→'))).toBe(true);
  });

  it('list renders stale-clean as a warning', async () => {
    const wtPath = join(tmpRoot, 'wt-stale-clean');
    await fs.mkdir(wtPath, { recursive: true });

    mockRunSweep.mockResolvedValue({
      candidates: [{ path: wtPath, verdict: 'stale-clean', owner: 'interactive', ageMs: 99_000_000 }],
      removed: [],
      warnings: [],
      dryRun: true,
    });

    const { ctx, lines } = makeCtx();
    await worktreeCmd.handler(ctx, 'list');

    const tail = wtPath.slice(-44);
    const row = lines.find((l) => l.includes(tail.slice(-20)));
    expect(row).toContain('stale-clean');
    expect(row).toContain('warn');
    expect(row).not.toContain('no');
  });

  it('prune without --apply runs as dry-run', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [
        { path: '/some/path', verdict: 'dead-owner', owner: 'interactive', ageMs: 60_000 },
      ],
      removed: [],
      warnings: [],
      dryRun: true,
    });

    const { ctx, lines } = makeCtx();
    const result = await worktreeCmd.handler(ctx, 'prune');
    expect(result).toBe('continue');
    expect(mockRunSweep.mock.calls[0]?.[0]?.dryRun).toBe(true);
    expect(lines.some((l) => l.includes('Dry-run'))).toBe(true);
    expect(lines.some((l) => l.includes('dead-owner=1'))).toBe(true);
  });

  it('prune --apply runs the sweep for real', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [
        { path: '/some/path', verdict: 'dead-owner', owner: 'interactive', ageMs: 60_000 },
      ],
      removed: ['/some/path'],
      warnings: [],
      dryRun: false,
    });

    const { ctx, lines } = makeCtx();
    await worktreeCmd.handler(ctx, 'prune --apply');
    expect(mockRunSweep.mock.calls[0]?.[0]?.dryRun).toBe(false);
    expect(lines.some((l) => l.includes('SUCCESS:Removed 1'))).toBe(true);
  });

  it('passes --scope through to runSweep', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [],
      removed: [],
      warnings: [],
      dryRun: true,
    });
    const { ctx } = makeCtx();
    await worktreeCmd.handler(ctx, 'prune --scope all');
    expect(mockRunSweep.mock.calls[0]?.[0]?.scope).toBe('all');
  });

  it('defaults scope to "interactive"', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [],
      removed: [],
      warnings: [],
      dryRun: true,
    });
    const { ctx } = makeCtx();
    await worktreeCmd.handler(ctx, 'list');
    expect(mockRunSweep.mock.calls[0]?.[0]?.scope).toBe('interactive');
  });

  it('rejects unknown subcommands with usage hint', async () => {
    const { ctx, lines } = makeCtx();
    const result = await worktreeCmd.handler(ctx, 'frobnicate');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('ERROR:') && l.includes('Unknown'))).toBe(true);
    expect(mockRunSweep).not.toHaveBeenCalled();
  });

  it('warns on unknown args', async () => {
    mockRunSweep.mockResolvedValue({
      candidates: [],
      removed: [],
      warnings: [],
      dryRun: true,
    });
    const { ctx, lines } = makeCtx();
    await worktreeCmd.handler(ctx, 'list --bogus-flag');
    expect(lines.some((l) => l.startsWith('WARN:') && l.includes('--bogus-flag'))).toBe(true);
  });
});
