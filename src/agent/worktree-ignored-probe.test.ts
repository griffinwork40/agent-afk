/**
 * Tests for the sweep's non-rebuildable ignored-file probe (#759).
 *
 * The two directions both matter: missing a `.env` means the sweep force-deletes
 * unrecoverable local state, while treating `node_modules/` as protective would
 * make every worktree immortal and stop the sweep reclaiming anything at all.
 */

import { describe, it, expect } from 'vitest';
import {
  isRebuildableIgnoredEntry,
  hasNonRebuildableIgnoredFiles,
} from './worktree-ignored-probe.js';
import type { ExecFileFn } from './worktree-sweep.js';

function mockExec(stdout: string): ExecFileFn {
  return (async () => ({ stdout, stderr: '' })) as unknown as ExecFileFn;
}

const throwingExec: ExecFileFn = (async () => {
  throw new Error('fatal: not a git repository');
}) as unknown as ExecFileFn;

describe('isRebuildableIgnoredEntry', () => {
  const rebuildable = [
    'node_modules/', 'node_modules/foo/index.js', '.pnpm/', '.yarn/',
    'dist/', 'dist/cli/index.js', 'build/', 'out/', '.next/', 'target/',
    '.turbo/', '.vite/', '.cache/', 'coverage/', '.nyc_output/',
    'tsconfig.tsbuildinfo', 'app.tsbuildinfo', '.eslintcache',
    '__pycache__/', '.venv/', '.DS_Store', 'debug.log',
    '.afk-worktree-meta.json',
    'packages/app/node_modules/', 'packages/app/dist/',
    'crates/server/target/', 'packages/app/.cache/',
  ];
  for (const entry of rebuildable) {
    it(`treats ${entry} as rebuildable`, () => {
      expect(isRebuildableIgnoredEntry(entry)).toBe(true);
    });
  }

  const protective = [
    '.env', '.env.local', '.env.production',
    'secrets.json', 'local-notes.md', 'scratch/data.csv',
    '.vscode/launch.json', '.idea/workspace.xml',
    'fixtures/recorded-response.bin',
  ];
  for (const entry of protective) {
    it(`treats ${entry} as NON-rebuildable`, () => {
      expect(isRebuildableIgnoredEntry(entry)).toBe(false);
    });
  }

  it('does not confuse a file containing a rebuildable directory name with output', () => {
    expect(isRebuildableIgnoredEntry('my-notes/dist-plan.md')).toBe(false);
  });
});

describe('hasNonRebuildableIgnoredFiles', () => {
  it('is false when every ignored entry is rebuildable', async () => {
    const exec = mockExec(
      '!! .afk-worktree-meta.json\n!! packages/app/node_modules/\n!! packages/app/dist/\n',
    );
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(false);
  });

  it('is true when any ignored entry is not rebuildable', async () => {
    const exec = mockExec('!! node_modules/\n!! .env\n');
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(true);
  });

  it('is false for an entirely clean tree', async () => {
    expect(await hasNonRebuildableIgnoredFiles(mockExec(''), '/tmp/wt')).toBe(false);
  });

  it('ignores non-`!!` porcelain lines (tracked/untracked entries)', async () => {
    // ` M src/x.ts` and `?? scratch` are the dirty signal's business, not ours.
    const exec = mockExec(' M src/x.ts\n?? scratch.txt\n!! dist/\n');
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(false);
  });

  it('fails SAFE — an unreadable tree protects rather than reaps', async () => {
    expect(await hasNonRebuildableIgnoredFiles(throwingExec, '/tmp/wt')).toBe(true);
  });
});
