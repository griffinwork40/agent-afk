/**
 * Tests for the worktree occupancy touch helper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  touchWorktreeOccupancy,
  worktreeRootFor,
  startWorktreeOccupancyHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
} from './worktree-occupancy.js';
import { MIN_EMPTY_AGE_MS } from './worktree-sweep.js';

let repoRoot: string;
let worktreePath: string;

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'occupancy-'));
  worktreePath = join(repoRoot, '.afk-worktrees', 'my-wt');
  await fs.mkdir(worktreePath, { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('worktreeRootFor', () => {
  it('resolves the worktree root from the root itself', () => {
    expect(worktreeRootFor(worktreePath)).toBe(worktreePath);
  });

  it('resolves the worktree root from a nested path', () => {
    expect(worktreeRootFor(join(worktreePath, 'src', 'deep'))).toBe(worktreePath);
  });

  it('returns undefined for paths outside .afk-worktrees/', () => {
    expect(worktreeRootFor(repoRoot)).toBeUndefined();
    expect(worktreeRootFor('/tmp/elsewhere')).toBeUndefined();
  });

  it('returns undefined for the bare .afk-worktrees dir itself', () => {
    // Trailing separator makes the post-segment slug empty.
    expect(worktreeRootFor(join(repoRoot, '.afk-worktrees') + sep)).toBeUndefined();
  });
});

describe('touchWorktreeOccupancy', () => {
  it('refreshes pid and createdAt while preserving other meta fields', async () => {
    const metaPath = join(worktreePath, '.afk-worktree-meta.json');
    const staleDate = new Date(Date.now() - 86_400_000 * 30).toISOString();
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        owner: 'interactive',
        pid: 999_999,
        createdAt: staleDate,
        baseSha: 'abc123',
        baseBranch: 'main',
      }),
    );

    await touchWorktreeOccupancy(join(worktreePath, 'src'));

    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['pid']).toBe(process.pid);
    expect(meta['createdAt']).not.toBe(staleDate);
    expect(Date.now() - new Date(meta['createdAt'] as string).getTime()).toBeLessThan(60_000);
    // Preserved fields
    expect(meta['owner']).toBe('interactive');
    expect(meta['baseSha']).toBe('abc123');
    expect(meta['baseBranch']).toBe('main');
  });

  it('creates minimal meta (owner agent) when none exists — adopts ghost worktrees', async () => {
    await touchWorktreeOccupancy(worktreePath);
    const meta = JSON.parse(
      await fs.readFile(join(worktreePath, '.afk-worktree-meta.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(meta['owner']).toBe('agent');
    expect(meta['pid']).toBe(process.pid);
    expect(typeof meta['createdAt']).toBe('string');
  });

  it('recovers from corrupt meta by rewriting a minimal one', async () => {
    const metaPath = join(worktreePath, '.afk-worktree-meta.json');
    await fs.writeFile(metaPath, '{not json');
    await touchWorktreeOccupancy(worktreePath);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['owner']).toBe('agent');
    expect(meta['pid']).toBe(process.pid);
  });

  it('no-ops for paths outside .afk-worktrees/', async () => {
    await touchWorktreeOccupancy(repoRoot);
    await expect(
      fs.access(join(repoRoot, '.afk-worktree-meta.json')),
    ).rejects.toThrow();
  });

  it('never throws when the worktree dir does not exist', async () => {
    await expect(
      touchWorktreeOccupancy(join(repoRoot, '.afk-worktrees', 'gone', 'src')),
    ).resolves.toBeUndefined();
  });
});

describe('startWorktreeOccupancyHeartbeat', () => {
  it('re-asserts occupancy on an interval so a long child never ages out (#759)', async () => {
    const metaPath = join(worktreePath, '.afk-worktree-meta.json');
    // Backdate meta well past the sweep's 1h MIN_EMPTY_AGE_MS: this is the state
    // a >1h child used to be reaped in.
    await fs.writeFile(
      metaPath,
      JSON.stringify({ owner: 'agent', createdAt: new Date(Date.now() - 7_200_000).toISOString() }),
    );

    const stop = startWorktreeOccupancyHeartbeat(worktreePath, 10);
    try {
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      stop();
    }

    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    const ageMs = Date.now() - new Date(String(meta['createdAt'])).getTime();
    expect(ageMs).toBeLessThan(3_600_000);
    expect(meta['pid']).toBe(process.pid);
    expect(meta['owner']).toBe('agent'); // unrelated fields preserved
  });

  it('stops touching after stop() is called', async () => {
    const metaPath = join(worktreePath, '.afk-worktree-meta.json');
    await fs.writeFile(metaPath, JSON.stringify({ owner: 'agent' }));

    const stop = startWorktreeOccupancyHeartbeat(worktreePath, 10);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    // Allow any in-flight touch that was already past the cancellation check
    // (i.e. between the first await and the rename) to land before we snapshot
    // "afterStop". The assertion is that no NEW writes happen after stop() —
    // not that the write queue is instantaneously flushed at the moment stop()
    // returns. Without this delay, on a slow CI runner the rename can land
    // after the "afterStop" read but before the "later" read, causing a false
    // timestamp mismatch (reproduces on macOS-latest; see PR #1002).
    await new Promise((r) => setTimeout(r, 30));
    const afterStop = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;

    await new Promise((r) => setTimeout(r, 60));
    const later = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(later['createdAt']).toBe(afterStop['createdAt']);
  });

  it('is idempotent — calling stop() twice is safe', async () => {
    const stop = startWorktreeOccupancyHeartbeat(worktreePath, 10);
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('returns an inert stop for a cwd outside a managed worktree', async () => {
    const outside = join(repoRoot, 'not-a-worktree');
    await fs.mkdir(outside, { recursive: true });
    const stop = startWorktreeOccupancyHeartbeat(outside, 10);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    await expect(fs.readFile(join(outside, '.afk-worktree-meta.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('DEFAULT_HEARTBEAT_INTERVAL_MS vs. MIN_EMPTY_AGE_MS', () => {
  // #759: the heartbeat only re-arms the sweep's age gate if a tick reliably
  // lands before the gate re-opens. Before this test the two constants were
  // private in different files, linked only by a prose comment — raising the
  // interval above the gate would silently reintroduce the bug with zero test
  // failures. No timers: plain arithmetic on the exported constants.
  it('stays comfortably below the sweep age gate (<= 1/4 of it, margin explicit)', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(MIN_EMPTY_AGE_MS / 4);
  });
});

/**
 * The disarm and the atomic-write temp path both had gaps that only show up
 * under concurrency: `clearInterval` cannot stop a touch already past its first
 * await, and a pid-only temp name collides across in-process subagents sharing
 * one cwd.
 */
describe('heartbeat disarm and write isolation', () => {
  it('honours cancellation mid-flight and leaves the meta byte-identical', async () => {
    const metaPath = join(worktreePath, '.afk-worktree-meta.json');
    await fs.writeFile(metaPath, JSON.stringify({ owner: 'agent', createdAt: 'ORIGINAL' }));

    // Cancel before the rename lands: the meta must not be re-stamped.
    await touchWorktreeOccupancy(worktreePath, () => true);

    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['createdAt']).toBe('ORIGINAL');
    const leftovers = (await fs.readdir(worktreePath)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('writes normally when not cancelled', async () => {
    const metaPath = join(worktreePath, '.afk-worktree-meta.json');
    await fs.writeFile(metaPath, JSON.stringify({ owner: 'agent', createdAt: 'ORIGINAL' }));
    await touchWorktreeOccupancy(worktreePath, () => false);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta['createdAt']).not.toBe('ORIGINAL');
  });

  // Two heartbeats armed for one root in a single process (a worktree-isolated
  // parent fanning out subagents) must not share a temp filename.
  it('survives concurrent touches without leaking a temp file or a torn meta', async () => {
    const metaPath = join(worktreePath, '.afk-worktree-meta.json');
    await fs.writeFile(metaPath, JSON.stringify({ owner: 'agent' }));

    await Promise.all(
      Array.from({ length: 8 }, () => touchWorktreeOccupancy(worktreePath)),
    );

    const raw = await fs.readFile(metaPath, 'utf-8');
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    expect((JSON.parse(raw) as Record<string, unknown>)['pid']).toBe(process.pid);
    const leftovers = (await fs.readdir(worktreePath)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('unrefs the interval so a pending heartbeat cannot hold the process open', () => {
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    try {
      const stop = startWorktreeOccupancyHeartbeat(worktreePath, 10);
      expect(unref).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      spy.mockRestore();
    }
  });
});
