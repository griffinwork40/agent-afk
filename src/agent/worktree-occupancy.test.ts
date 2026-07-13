/**
 * Tests for the worktree occupancy touch helper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { touchWorktreeOccupancy, worktreeRootFor } from './worktree-occupancy.js';

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
