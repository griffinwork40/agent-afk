/**
 * Tests for the sweep root registry (#761).
 *
 * AFK_STATE_DIR is repointed at a tmpdir per test so the registry never touches
 * the developer's real ~/.afk state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  registerWorktreeRoot,
  readRegisteredWorktreeRoots,
  sweepRootSet,
} from './worktree-root-registry.js';
import { getWorktreeRootsRegistryPath } from '../paths.js';

let stateDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'wt-roots-'));
  prevStateDir = process.env['AFK_STATE_DIR'];
  process.env['AFK_STATE_DIR'] = stateDir;
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  if (prevStateDir === undefined) delete process.env['AFK_STATE_DIR'];
  else process.env['AFK_STATE_DIR'] = prevStateDir;
});

async function mkRepo(name: string): Promise<string> {
  const p = join(stateDir, name);
  await fs.mkdir(p, { recursive: true });
  return p;
}

describe('registerWorktreeRoot', () => {
  it('records a root and reads it back', async () => {
    const repo = await mkRepo('repo-a');
    await registerWorktreeRoot(repo);
    expect(await readRegisteredWorktreeRoots()).toEqual([repo]);
  });

  it('is idempotent — re-registering does not duplicate', async () => {
    const repo = await mkRepo('repo-a');
    await registerWorktreeRoot(repo);
    await registerWorktreeRoot(repo);
    await registerWorktreeRoot(repo);
    expect(await readRegisteredWorktreeRoots()).toEqual([repo]);
  });

  it('accumulates distinct roots — the whole point of the registry', async () => {
    const a = await mkRepo('repo-a');
    const b = await mkRepo('repo-b');
    await registerWorktreeRoot(a);
    await registerWorktreeRoot(b);
    const roots = await readRegisteredWorktreeRoots();
    expect(roots).toHaveLength(2);
    expect(roots).toEqual(expect.arrayContaining([a, b]));
  });

  it('never throws on an unwritable state dir (best-effort contract)', async () => {
    // Point the state dir BENEATH a regular file: mkdir then fails immediately
    // with ENOTDIR on every platform. (Do not reach for a path under /proc —
    // mkdir there hangs on Linux rather than erroring, which times the test out
    // instead of exercising the contract.)
    const blocker = join(stateDir, 'not-a-dir');
    await fs.writeFile(blocker, 'x', 'utf-8');
    process.env['AFK_STATE_DIR'] = join(blocker, 'nested');
    await expect(registerWorktreeRoot('/tmp/whatever')).resolves.toBeUndefined();
  });

  it('ignores an empty root', async () => {
    await registerWorktreeRoot('');
    expect(await readRegisteredWorktreeRoots()).toEqual([]);
  });
});

describe('readRegisteredWorktreeRoots', () => {
  it('is empty when no registry exists', async () => {
    expect(await readRegisteredWorktreeRoots()).toEqual([]);
  });

  it('prunes a root whose directory no longer exists, and self-heals the file', async () => {
    const alive = await mkRepo('alive');
    const doomed = await mkRepo('doomed');
    await registerWorktreeRoot(alive);
    await registerWorktreeRoot(doomed);
    rmSync(doomed, { recursive: true, force: true });

    expect(await readRegisteredWorktreeRoots()).toEqual([alive]);

    // The prune is persisted, not recomputed on every read.
    const onDisk = JSON.parse(
      await fs.readFile(getWorktreeRootsRegistryPath(), 'utf-8'),
    ) as { roots: Array<{ path: string }> };
    expect(onDisk.roots.map((r) => r.path)).toEqual([alive]);
  });

  it('returns empty on a corrupt registry rather than throwing', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(getWorktreeRootsRegistryPath(), '{not json', 'utf-8');
    expect(await readRegisteredWorktreeRoots()).toEqual([]);
  });

  it('skips an entry that exists but is a file, not a directory', async () => {
    const notADir = join(stateDir, 'a-file');
    await fs.writeFile(notADir, 'x', 'utf-8');
    await registerWorktreeRoot(notADir);
    expect(await readRegisteredWorktreeRoots()).toEqual([]);
  });

  it('retains (does not prune) a root on a transient EACCES, and it reappears once the error clears', async () => {
    // Regression for review item 2: every stat rejection used to be read as
    // "directory gone" and pruned+persisted. A transient EACCES (unmounted
    // volume, an ancestor that lost +x) must NOT drop a live root — the entry
    // stays absent from THIS pass' result but stays IN THE FILE, and a later
    // read (once the error clears) returns it again with no re-registration.
    const flaky = await mkRepo('flaky');
    await registerWorktreeRoot(flaky);

    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      if (String(target) === flaky) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realStat(target as Parameters<typeof fs.stat>[0]);
    });

    expect(await readRegisteredWorktreeRoots()).toEqual([]);

    // Still on disk — a real ENOENT/ENOTDIR prune would have dropped it here.
    const onDisk = JSON.parse(
      await fs.readFile(getWorktreeRootsRegistryPath(), 'utf-8'),
    ) as { roots: Array<{ path: string }> };
    expect(onDisk.roots.map((r) => r.path)).toEqual([flaky]);

    statSpy.mockRestore();

    // Error cleared — the root reappears with no re-registration required.
    expect(await readRegisteredWorktreeRoots()).toEqual([flaky]);
  });
});

describe('sweepRootSet', () => {
  it('puts the primary root first, then registered roots', async () => {
    const primary = await mkRepo('primary');
    const other = await mkRepo('other');
    await registerWorktreeRoot(other);
    expect(await sweepRootSet(primary)).toEqual([primary, other]);
  });

  it('does not duplicate a primary that is also registered', async () => {
    const repo = await mkRepo('repo');
    await registerWorktreeRoot(repo);
    expect(await sweepRootSet(repo)).toEqual([repo]);
  });

  it('includes an explicitly named primary even when it is not registered', async () => {
    const primary = await mkRepo('explicit');
    expect(await sweepRootSet(primary)).toEqual([primary]);
  });

  it('returns registered roots when there is no primary (daemon cwd outside any repo)', async () => {
    const a = await mkRepo('repo-a');
    await registerWorktreeRoot(a);
    expect(await sweepRootSet(null)).toEqual([a]);
  });

  it('is empty when there is neither a primary nor a registry', async () => {
    expect(await sweepRootSet(null)).toEqual([]);
  });
});

describe('durability and concurrency', () => {
  it('keeps every root when many are registered in parallel', async () => {
    // Regression: the read-modify-write used to be unserialized, so concurrent
    // registrations each read the same snapshot and the last write won —
    // a 20-root parallel registration retained exactly one. Every dropped root
    // is a root whose managed worktrees leak forever (#761).
    const repos = await Promise.all(
      Array.from({ length: 20 }, (_, i) => mkRepo(`par-${String(i)}`)),
    );
    await Promise.all(repos.map((r) => registerWorktreeRoot(r)));

    const roots = await readRegisteredWorktreeRoots();
    expect(roots).toHaveLength(repos.length);
    expect(roots).toEqual(expect.arrayContaining(repos));
  });

  it('caps retention at 64 roots, evicting the least-recently-seen first', async () => {
    const repos: string[] = [];
    for (let i = 0; i < 65; i++) {
      // Sequential, so "first registered" is unambiguously the oldest-seen.
      const repo = await mkRepo(`cap-${String(i).padStart(3, '0')}`);
      repos.push(repo);
      await registerWorktreeRoot(repo);
    }

    const roots = await readRegisteredWorktreeRoots();
    expect(roots).toHaveLength(64);
    expect(roots).not.toContain(repos[0]);
    expect(roots).toContain(repos[64]);
  });

  it('refreshing an existing root does not evict a different live root', async () => {
    const a = await mkRepo('keep-a');
    const b = await mkRepo('keep-b');
    await registerWorktreeRoot(a);
    await registerWorktreeRoot(b);
    await registerWorktreeRoot(a); // re-registration reorders, must not drop b

    expect(await readRegisteredWorktreeRoots()).toEqual(expect.arrayContaining([a, b]));
  });

  it('leaves no temp or lock files behind after a write', async () => {
    const repo = await mkRepo('tidy');
    await registerWorktreeRoot(repo);

    const siblings = await fs.readdir(dirname(getWorktreeRootsRegistryPath()));
    expect(siblings.filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(siblings.filter((f) => f.endsWith('.lock'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'writes the registry 0o600 — it lists every repo the user works in',
    async () => {
      const repo = await mkRepo('perms');
      await registerWorktreeRoot(repo);

      const stat = await fs.stat(getWorktreeRootsRegistryPath());
      expect(stat.mode & 0o777).toBe(0o600);
    },
  );

  it('still records the root when the lock is held by a live foreign process', async () => {
    // Contract: the advisory lock is DEGRADABLE. Registration runs inside
    // worktree creation, so a contended lock must cost a rare lost update, not
    // a blocked or failed create. A live holder that never releases must
    // therefore not prevent the write — it only delays it to the timeout.
    const repo = await mkRepo('contended');
    await fs.mkdir(dirname(getWorktreeRootsRegistryPath()), { recursive: true });
    // process.pid is alive by definition, so the stale-lock reclaim path cannot
    // fire and the writer must fall through to its timeout instead.
    await fs.writeFile(`${getWorktreeRootsRegistryPath()}.lock`, String(process.pid), 'utf-8');

    await registerWorktreeRoot(repo);

    expect(await readRegisteredWorktreeRoots()).toContain(repo);
  }, 15_000);

  it('survives a torn registry left by an interrupted write', async () => {
    const repo = await mkRepo('after-tear');
    await fs.mkdir(dirname(getWorktreeRootsRegistryPath()), { recursive: true });
    // A truncated JSON body is what a non-atomic writer leaves on a crash.
    await fs.writeFile(getWorktreeRootsRegistryPath(), '{"version":1,"roots":[{"pa', 'utf-8');

    await registerWorktreeRoot(repo);
    expect(await readRegisteredWorktreeRoots()).toEqual([repo]);
  });
});
