/**
 * Tests for the Speculative Branch Farm worktree isolation layer.
 *
 * These tests exercise real `git worktree` operations against ephemeral
 * temp repos. Each test gets its own AFK_HOME and source-repo dir, so they
 * are safe to parallelise.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFarm,
  listFarms,
  loadFarm,
  MAX_FARM_BRANCHES,
  recordHumanDecision,
  recordPrCreated,
  recordRespawn,
  removeBranch,
  removeFarm,
  setFarmMemoryFactId,
  WorktreeError,
} from './worktree.js';

const execFileAsync = promisify(execFile);

async function run(cwd: string, cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { cwd });
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'afk-farm-src-'));
  await run(repo, 'git', ['init', '-q', '-b', 'main']);
  await run(repo, 'git', ['config', 'user.email', 'test@afk.local']);
  await run(repo, 'git', ['config', 'user.name', 'AFK Test']);
  await fs.writeFile(join(repo, 'README.md'), '# seed\n', 'utf8');
  await run(repo, 'git', ['add', '.']);
  await run(repo, 'git', ['commit', '-q', '-m', 'seed']);
  return repo;
}

function makeAfkHome(): string {
  return mkdtempSync(join(tmpdir(), 'afk-farm-home-'));
}

let savedAfkHome: string | undefined;
let repoRoot: string;
let afkHome: string;

beforeEach(async () => {
  savedAfkHome = process.env['AFK_HOME'];
  afkHome = makeAfkHome();
  process.env['AFK_HOME'] = afkHome;
  repoRoot = await makeRepo();
});

afterEach(async () => {
  if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedAfkHome;
  await fs.rm(afkHome, { recursive: true, force: true });
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe('createFarm', () => {
  it('spawns N worktrees on N fresh branches and writes a manifest', async () => {
    const manifest = await createFarm({
      taskName: 'rewrite auth to jose',
      count: 3,
      cwd: repoRoot,
      now: () => new Date('2026-05-14T15:30:00Z'),
      randomSuffix: () => 'a3f2',
    });

    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.branches).toHaveLength(3);
    expect(manifest.taskSlug).toBe('20260514T153000-rewrite-auth-to-jose-a3f2');
    expect(manifest.baseRef).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.baseBranch).toBe('refs/heads/main');

    // Each worktree exists on disk and is registered with git.
    const registered = await run(repoRoot, 'git', ['worktree', 'list', '--porcelain']);
    for (const b of manifest.branches) {
      expect(b.path).toContain(afkHome);
      expect(b.branch).toMatch(
        /^afk\/farm\/20260514T153000-rewrite-auth-to-jose-a3f2\/\d+-branch-\d+$/,
      );
      const stat = await fs.stat(b.path);
      expect(stat.isDirectory()).toBe(true);
      expect(registered).toContain(b.path);
    }

    // Manifest written to disk and round-trips.
    const reloaded = await loadFarm(manifest.taskSlug);
    expect(reloaded).toEqual(manifest);
  });

  it('honours per-branch labels in the branch ref name', async () => {
    const manifest = await createFarm({
      taskName: 'auth rewrite',
      count: 2,
      labels: ['jose+zod', 'jose-only'],
      cwd: repoRoot,
      taskSlug: 'fixed-slug-for-test',
    });
    expect(manifest.branches[0].branch).toBe('afk/farm/fixed-slug-for-test/1-jose-zod');
    expect(manifest.branches[1].branch).toBe('afk/farm/fixed-slug-for-test/2-jose-only');
    expect(manifest.branches[0].label).toBe('jose-zod');
  });

  it('rejects count outside [1, MAX_FARM_BRANCHES]', async () => {
    await expect(createFarm({ taskName: 't', count: 0, cwd: repoRoot })).rejects.toThrow(
      WorktreeError,
    );
    await expect(
      createFarm({ taskName: 't', count: MAX_FARM_BRANCHES + 1, cwd: repoRoot }),
    ).rejects.toThrow(WorktreeError);
  });

  it('rejects mismatched labels length', async () => {
    await expect(
      createFarm({ taskName: 't', count: 3, labels: ['a', 'b'], cwd: repoRoot }),
    ).rejects.toThrow(/labels.length/);
  });

  it('rejects a non-git cwd', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'afk-farm-notgit-'));
    try {
      await expect(createFarm({ taskName: 't', count: 1, cwd: notARepo })).rejects.toThrow(
        WorktreeError,
      );
    } finally {
      await fs.rm(notARepo, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing farm dir', async () => {
    await createFarm({
      taskName: 'first',
      count: 1,
      cwd: repoRoot,
      taskSlug: 'collision',
    });
    await expect(
      createFarm({ taskName: 'second', count: 1, cwd: repoRoot, taskSlug: 'collision' }),
    ).rejects.toThrow(/already exists/);
  });

  it('rolls back partial worktrees on mid-creation failure', async () => {
    // Force a collision on branch #2 by pre-creating its branch ref. The first
    // worktree should succeed, the second should fail, and rollback should
    // remove the first one and the farm dir.
    const slug = 'rollback-test';
    await run(repoRoot, 'git', ['branch', `afk/farm/${slug}/2-branch-2`]);

    await expect(
      createFarm({ taskName: 'rollback', count: 3, cwd: repoRoot, taskSlug: slug }),
    ).rejects.toThrow(WorktreeError);

    // Farm dir should not exist.
    await expect(fs.access(join(afkHome, 'farms', slug))).rejects.toThrow();

    // The first branch we created should be cleaned up; the pre-existing #2 should remain.
    const branches = await run(repoRoot, 'git', ['branch', '--list', `afk/farm/${slug}/*`]);
    expect(branches).not.toContain('1-branch-1');
    expect(branches).toContain('2-branch-2');

    // No dangling worktree registrations.
    const wts = await run(repoRoot, 'git', ['worktree', 'list', '--porcelain']);
    expect(wts).not.toContain(`afk/farm/${slug}`);
  });
});

describe('listFarms / loadFarm', () => {
  it('returns [] when no farms exist', async () => {
    expect(await listFarms()).toEqual([]);
  });

  it('lists created farms', async () => {
    await createFarm({ taskName: 'a', count: 1, cwd: repoRoot, taskSlug: 'one' });
    await createFarm({ taskName: 'b', count: 1, cwd: repoRoot, taskSlug: 'two' });
    const farms = await listFarms();
    expect(farms.sort()).toEqual(['one', 'two']);
  });

  it('returns null for an unknown slug', async () => {
    expect(await loadFarm('does-not-exist')).toBeNull();
  });
});

describe('removeBranch', () => {
  it('removes a single branch and updates the manifest', async () => {
    const manifest = await createFarm({
      taskName: 't',
      count: 3,
      cwd: repoRoot,
      taskSlug: 'rm-branch',
    });
    await removeBranch('rm-branch', 2);

    const reloaded = await loadFarm('rm-branch');
    expect(reloaded?.branches.map((b) => b.index)).toEqual([1, 3]);

    // Branch 2's worktree dir is gone.
    await expect(fs.access(manifest.branches[1].path)).rejects.toThrow();

    // The branch ref is gone.
    const branches = await run(repoRoot, 'git', [
      'branch',
      '--list',
      'afk/farm/rm-branch/*',
    ]);
    expect(branches).not.toContain('2-branch-2');
    expect(branches).toContain('1-branch-1');
    expect(branches).toContain('3-branch-3');
  });

  it('throws on unknown taskSlug', async () => {
    await expect(removeBranch('nope', 1)).rejects.toThrow(/farm not found/);
  });
});

describe('removeFarm', () => {
  it('removes all branches and the farm dir', async () => {
    await createFarm({
      taskName: 't',
      count: 2,
      cwd: repoRoot,
      taskSlug: 'rm-farm',
    });
    await removeFarm('rm-farm');

    expect(await loadFarm('rm-farm')).toBeNull();
    const branches = await run(repoRoot, 'git', [
      'branch',
      '--list',
      'afk/farm/rm-farm/*',
    ]);
    expect(branches).toBe('');
  });

  it('is idempotent on a missing farm', async () => {
    await expect(removeFarm('never-existed')).resolves.not.toThrow();
  });
});

describe('manifest schema v2 + human decision', () => {
  it('createFarm writes schemaVersion: 3 (updated from v2)', async () => {
    const manifest = await createFarm({
      taskName: 'schema v2 check',
      count: 1,
      cwd: repoRoot,
      taskSlug: 'schema-v2-check',
    });
    const raw = await fs.readFile(
      join(afkHome, 'farms', 'schema-v2-check', 'farm.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { schemaVersion: number };
    expect(manifest.schemaVersion).toBe(3);
    expect(parsed.schemaVersion).toBe(3);
  });

  it('loadFarm accepts schemaVersion: 1 (backward compat)', async () => {
    // Hand-write a minimal v1 manifest to disk.
    const slug = 'hand-v1';
    const farmDir = join(afkHome, 'farms', slug);
    await fs.mkdir(farmDir, { recursive: true });
    const v1: Record<string, unknown> = {
      schemaVersion: 1,
      taskId: slug,
      taskSlug: slug,
      taskName: 'hand v1',
      repoRoot,
      baseRef: 'abc123',
      farmDir,
      createdAt: new Date().toISOString(),
      branches: [],
    };
    await fs.writeFile(join(farmDir, 'farm.json'), JSON.stringify(v1, null, 2) + '\n', 'utf8');

    const loaded = await loadFarm(slug);
    expect(loaded).not.toBeNull();
    expect(loaded?.schemaVersion).toBe(1);
  });

  it('loadFarm accepts schemaVersion: 2', async () => {
    const slug = 'hand-v2';
    const farmDir = join(afkHome, 'farms', slug);
    await fs.mkdir(farmDir, { recursive: true });
    const v2: Record<string, unknown> = {
      schemaVersion: 2,
      taskId: slug,
      taskSlug: slug,
      taskName: 'hand v2',
      repoRoot,
      baseRef: 'abc123',
      farmDir,
      createdAt: new Date().toISOString(),
      branches: [],
    };
    await fs.writeFile(join(farmDir, 'farm.json'), JSON.stringify(v2, null, 2) + '\n', 'utf8');

    const loaded = await loadFarm(slug);
    expect(loaded).not.toBeNull();
    expect(loaded?.schemaVersion).toBe(2);
  });

  it('loadFarm rejects schemaVersion: 4', async () => {
    const slug = 'hand-v4';
    const farmDir = join(afkHome, 'farms', slug);
    await fs.mkdir(farmDir, { recursive: true });
    const v4: Record<string, unknown> = {
      schemaVersion: 4,
      taskId: slug,
      taskSlug: slug,
      taskName: 'hand v4',
      repoRoot,
      baseRef: 'abc123',
      farmDir,
      createdAt: new Date().toISOString(),
      branches: [],
    };
    await fs.writeFile(join(farmDir, 'farm.json'), JSON.stringify(v4, null, 2) + '\n', 'utf8');

    await expect(loadFarm(slug)).rejects.toThrow(/expected 1, 2, or 3/);
  });

  it('loadFarm accepts schemaVersion: 3', async () => {
    const slug = 'hand-v3-accepted';
    const farmDir = join(afkHome, 'farms', slug);
    await fs.mkdir(farmDir, { recursive: true });
    const v3: Record<string, unknown> = {
      schemaVersion: 3,
      taskId: slug,
      taskSlug: slug,
      taskName: 'hand v3',
      repoRoot,
      baseRef: 'abc123',
      farmDir,
      createdAt: new Date().toISOString(),
      branches: [],
    };
    await fs.writeFile(join(farmDir, 'farm.json'), JSON.stringify(v3, null, 2) + '\n', 'utf8');
    const loaded = await loadFarm(slug);
    expect(loaded).not.toBeNull();
    expect(loaded?.schemaVersion).toBe(3);
  });

  it('recordHumanDecision: approved — sets fields and persists', async () => {
    await createFarm({
      taskName: 'decision approved',
      count: 1,
      cwd: repoRoot,
      taskSlug: 'decision-approved',
    });

    const before = Date.now();
    const updated = await recordHumanDecision('decision-approved', 'approved');
    const after = Date.now();

    expect(updated.human_decision).toBe('approved');
    expect(updated.schemaVersion).toBe(3);
    expect(updated.decidedAt).toBeDefined();
    const decidedMs = new Date(updated.decidedAt!).getTime();
    expect(decidedMs).toBeGreaterThanOrEqual(before);
    expect(decidedMs).toBeLessThanOrEqual(after);

    // Verify round-trip from disk.
    const reloaded = await loadFarm('decision-approved');
    expect(reloaded?.human_decision).toBe('approved');
    expect(reloaded?.decidedAt).toBe(updated.decidedAt);
    expect(reloaded?.schemaVersion).toBe(3);
  });

  it('recordHumanDecision: not-found throws WorktreeError', async () => {
    await expect(recordHumanDecision('no-such-farm', 'approved')).rejects.toThrow(
      WorktreeError,
    );
    await expect(recordHumanDecision('no-such-farm', 'approved')).rejects.toThrow(
      /farm not found/,
    );
  });

  it('recordHumanDecision: last write wins when called twice', async () => {
    await createFarm({
      taskName: 'decision overwrite',
      count: 1,
      cwd: repoRoot,
      taskSlug: 'decision-overwrite',
    });

    const first = await recordHumanDecision('decision-overwrite', 'rejected');
    expect(first.human_decision).toBe('rejected');

    const second = await recordHumanDecision('decision-overwrite', 'edited_then_merged');
    expect(second.human_decision).toBe('edited_then_merged');
    // decidedAt must be updated (or equal if clock resolution is coarse — just verify it's set)
    expect(second.decidedAt).toBeDefined();
    expect(second.schemaVersion).toBe(3);

    const reloaded = await loadFarm('decision-overwrite');
    expect(reloaded?.human_decision).toBe('edited_then_merged');
    expect(reloaded?.decidedAt).toBe(second.decidedAt);
    expect(reloaded?.schemaVersion).toBe(3);
  });

  it('createFarm writes schemaVersion: 3', async () => {
    const manifest = await createFarm({
      taskName: 'schema v3 check',
      count: 1,
      cwd: repoRoot,
      taskSlug: 'schema-v3-check',
    });
    expect(manifest.schemaVersion).toBe(3);
    const reloaded = await loadFarm('schema-v3-check');
    expect(reloaded?.schemaVersion).toBe(3);
  });
});

describe('recordRespawn', () => {
  let repoRoot: string;
  let afkHome: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    afkHome = makeAfkHome();
    process.env['AFK_HOME'] = afkHome;
  });

  afterEach(async () => {
    await run(repoRoot, 'git', ['worktree', 'prune']).catch(() => {});
  });

  it('sets respawnedAt/respawnedAs, bumps to v3, returns manifest, round-trips from disk', async () => {
    await createFarm({ taskName: 'respawn src', count: 1, cwd: repoRoot, taskSlug: 'respawn-src' });
    const before = Date.now();
    const updated = await recordRespawn('respawn-src', 'respawn-child-slug');
    const after = Date.now();

    expect(updated.respawnedAs).toBe('respawn-child-slug');
    expect(updated.respawnedAt).toBeDefined();
    expect(new Date(updated.respawnedAt!).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(updated.respawnedAt!).getTime()).toBeLessThanOrEqual(after);
    expect(updated.schemaVersion).toBe(3);

    const reloaded = await loadFarm('respawn-src');
    expect(reloaded?.respawnedAs).toBe('respawn-child-slug');
    expect(reloaded?.respawnedAt).toBe(updated.respawnedAt);
    expect(reloaded?.schemaVersion).toBe(3);
  });

  it('throws WorktreeError for unknown slug', async () => {
    await expect(recordRespawn('no-such-farm', 'child')).rejects.toThrow(WorktreeError);
    await expect(recordRespawn('no-such-farm', 'child')).rejects.toThrow(/farm not found/);
  });
});

describe('setFarmMemoryFactId', () => {
  let repoRoot: string;
  let afkHome: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    afkHome = makeAfkHome();
    process.env['AFK_HOME'] = afkHome;
  });

  afterEach(async () => {
    await run(repoRoot, 'git', ['worktree', 'prune']).catch(() => {});
  });

  it('writes memoryFactId, bumps to v3, returns manifest', async () => {
    await createFarm({ taskName: 'fact id store', count: 1, cwd: repoRoot, taskSlug: 'fact-id-store' });
    const updated = await setFarmMemoryFactId('fact-id-store', 42);
    expect(updated.memoryFactId).toBe(42);
    expect(updated.schemaVersion).toBe(3);
    const reloaded = await loadFarm('fact-id-store');
    expect(reloaded?.memoryFactId).toBe(42);
  });

  it('idempotent: second call with same factId does not throw', async () => {
    await createFarm({ taskName: 'fact id idem', count: 1, cwd: repoRoot, taskSlug: 'fact-id-idem' });
    await setFarmMemoryFactId('fact-id-idem', 7);
    const second = await setFarmMemoryFactId('fact-id-idem', 7);
    expect(second.memoryFactId).toBe(7);
  });

  it('throws WorktreeError for unknown slug', async () => {
    await expect(setFarmMemoryFactId('no-such-farm', 1)).rejects.toThrow(WorktreeError);
  });
});

// ---------------------------------------------------------------------------
// recordPrCreated
// ---------------------------------------------------------------------------

describe('recordPrCreated', () => {
  let repoRoot: string;
  let afkHome: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    afkHome = makeAfkHome();
    process.env['AFK_HOME'] = afkHome;
  });

  afterEach(async () => {
    await run(repoRoot, 'git', ['worktree', 'prune']).catch(() => {});
  });

  it('happy path: writes prUrl, prCreatedAt, bumps schemaVersion to 3', async () => {
    await createFarm({ taskName: 'pr created test', count: 1, cwd: repoRoot, taskSlug: 'pr-created-test' });
    const prUrl = 'https://github.com/org/repo/pull/99';
    const updated = await recordPrCreated('pr-created-test', prUrl);

    expect(updated.prUrl).toBe(prUrl);
    expect(updated.prCreatedAt).toBeDefined();
    expect(typeof updated.prCreatedAt).toBe('string');
    // ISO timestamp sanity check
    expect(() => new Date(updated.prCreatedAt!)).not.toThrow();
    expect(updated.schemaVersion).toBe(3);

    // Round-trip from disk
    const reloaded = await loadFarm('pr-created-test');
    expect(reloaded?.prUrl).toBe(prUrl);
    expect(reloaded?.prCreatedAt).toBe(updated.prCreatedAt);
  });

  it('throws WorktreeError when farm not found', async () => {
    await expect(
      recordPrCreated('no-such-farm', 'https://github.com/org/repo/pull/1'),
    ).rejects.toThrow(WorktreeError);
  });
});
