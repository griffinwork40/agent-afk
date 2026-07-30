/**
 * Tests for the sweep root registry (#761).
 *
 * AFK_STATE_DIR is repointed at a tmpdir per test so the registry never touches
 * the developer's real ~/.afk state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
    process.env['AFK_STATE_DIR'] = '/proc/nonexistent-cannot-write';
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
