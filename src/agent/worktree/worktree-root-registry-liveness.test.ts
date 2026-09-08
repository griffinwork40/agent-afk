/**
 * Tests for the liveness classifier behind the registry's prune-on-read (#771).
 *
 * The classifier is deliberately TRI-state — confirmed-dead (safe to prune),
 * confirmed-live (return), and unknown (retain in the file, skip this pass) —
 * because collapsing the third into the first is what let a single transient
 * filesystem error permanently drop a live root. Exercised directly here
 * rather than only through the registry, since the module owns that decision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyRootLiveness } from './worktree-root-registry-liveness.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wt-liveness-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('classifyRootLiveness', () => {
  it('separates live, confirmed-dead and unknown into three classes', async () => {
    const live = join(tmp, 'live');
    await fs.mkdir(live);
    const gone = join(tmp, 'gone'); // never created → real ENOENT
    const unreadable = join(tmp, 'unreadable');
    await fs.mkdir(unreadable);

    const realStat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      if (String(target) === unreadable) throw errno('EACCES');
      return realStat(target as Parameters<typeof fs.stat>[0]);
    });

    const { alive, dead } = await classifyRootLiveness([
      { path: live },
      { path: gone },
      { path: unreadable },
    ]);

    expect(alive.map((e) => e.path)).toEqual([live]);
    expect([...dead]).toEqual([gone]);
    // The decisive assertion: an unknown-errno root is in NEITHER list, so the
    // caller returns it to nobody and deletes it from nowhere.
    expect(dead.has(unreadable)).toBe(false);
    expect(alive.some((e) => e.path === unreadable)).toBe(false);
  });

  it('never lets one path land in both alive and dead when two entries duplicate it', async () => {
    // Two raw entries resolving to the same absolute path (one carries a
    // trailing slash). If `seen` were marked only on the live branch, the
    // second entry would re-stat after the first probe already recorded the
    // path as dead — the caller would then hand it to the sweep AND delete it
    // from the registry in the same pass, silently unregistering a live root.
    const repo = join(tmp, 'repo');
    await fs.mkdir(repo);

    let probes = 0;
    const realStat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      if (String(target) === repo) {
        probes += 1;
        if (probes === 1) throw errno('ENOENT'); // first probe: "gone"
        return realStat(target as Parameters<typeof fs.stat>[0]); // second: back
      }
      return realStat(target as Parameters<typeof fs.stat>[0]);
    });

    const { alive, dead, duplicates } = await classifyRootLiveness([
      { path: `${repo}/` },
      { path: repo },
    ]);

    const inAlive = alive.some((e) => e.path === repo);
    expect(inAlive && dead.has(repo)).toBe(false);
    expect(probes).toBe(1); // the duplicate short-circuited before its stat
    expect(duplicates).toBe(true);
  });

  it('treats a path that exists but is not a directory as confirmed-dead', async () => {
    const file = join(tmp, 'a-file');
    await fs.writeFile(file, 'x', 'utf-8');

    const { alive, dead } = await classifyRootLiveness([{ path: file }]);

    expect(alive).toEqual([]);
    expect([...dead]).toEqual([file]);
  });

  it('treats ENOTDIR as confirmed-dead', async () => {
    const file = join(tmp, 'file');
    await fs.writeFile(file, 'x', 'utf-8');
    const throughFile = join(file, 'nested'); // stat() → ENOTDIR

    const { alive, dead } = await classifyRootLiveness([{ path: throughFile }]);

    expect(alive).toEqual([]);
    expect([...dead]).toEqual([throughFile]);
  });

  it('reports duplicates: false when every entry is distinct', async () => {
    const a = join(tmp, 'a');
    const b = join(tmp, 'b');
    await fs.mkdir(a);
    await fs.mkdir(b);

    const { duplicates } = await classifyRootLiveness([{ path: a }, { path: b }]);

    expect(duplicates).toBe(false);
  });

  it('preserves non-path fields on the entries it returns', async () => {
    const live = join(tmp, 'live');
    await fs.mkdir(live);

    const { alive } = await classifyRootLiveness([
      { path: `${live}/`, lastSeenAt: '2026-01-01T00:00:00.000Z' },
    ]);

    // path normalized to absolute, lastSeenAt carried through untouched.
    expect(alive).toEqual([{ path: live, lastSeenAt: '2026-01-01T00:00:00.000Z' }]);
  });
});
