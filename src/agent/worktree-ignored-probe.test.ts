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

  // A sensitive leaf outranks its containing directory. Without this, the
  // build-output prefix patterns classify `dist/secrets.env` as reapable.
  const sensitiveUnderBuildOutput = [
    'dist/secrets.env', 'dist/.env', 'build/.env.local', 'out/private.pem',
    'target/service.key', 'coverage/id_rsa', 'dist/nested/app-credentials.json',
    'packages/app/dist/.env',
  ];
  for (const entry of sensitiveUnderBuildOutput) {
    it(`treats ${entry} as NON-rebuildable despite its parent directory`, () => {
      expect(isRebuildableIgnoredEntry(entry)).toBe(false);
    });
  }

  // The narrowed log rule: emitters stay reapable, hand-kept logs do not.
  it('treats a hand-kept log as NON-rebuildable', () => {
    expect(isRebuildableIgnoredEntry('decisions.log')).toBe(false);
    expect(isRebuildableIgnoredEntry('transcripts/session.log')).toBe(false);
  });

  it('keeps known log emitters rebuildable', () => {
    for (const entry of ['npm-debug.log', 'debug.log', 'pnpm-debug.log', 'logs/run.log']) {
      expect(isRebuildableIgnoredEntry(entry)).toBe(true);
    }
  });

  it('classifies a non-ASCII nested dependency dir as rebuildable', () => {
    expect(isRebuildableIgnoredEntry('café/node_modules/')).toBe(true);
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

/**
 * Traditional `--ignored` collapses an ignored directory to one line, so a
 * secret nested under `dist/` is invisible to the top-level call. These pin the
 * scoped second call that closes that blind spot — and pin that it is NOT paid
 * for dependency trees.
 */
describe('hasNonRebuildableIgnoredFiles — collapsed-directory expansion', () => {
  /** Records every git argv so a test can assert which calls were made. */
  function recordingExec(
    responder: (args: readonly string[]) => string,
  ): { exec: ExecFileFn; calls: string[][] } {
    const calls: string[][] = [];
    const exec = (async (_cmd: string, args: string[]) => {
      calls.push([...args]);
      return { stdout: responder(args), stderr: '' };
    }) as unknown as ExecFileFn;
    return { exec, calls };
  }

  const isScoped = (args: readonly string[]): boolean => args.includes('--untracked-files=all');

  it('expands a collapsed build dir and protects when it hides a secret', async () => {
    const { exec, calls } = recordingExec((args) =>
      isScoped(args) ? '!! dist/cli/index.js\n!! dist/secrets.env\n' : '!! dist/\n',
    );
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(true);
    expect(calls.filter(isScoped)).toHaveLength(1);
  });

  it('expands a collapsed build dir and reaps when it holds only output', async () => {
    const { exec, calls } = recordingExec((args) =>
      isScoped(args) ? '!! dist/cli/index.js\n!! dist/assets/app.css\n' : '!! dist/\n',
    );
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(false);
    expect(calls.filter(isScoped)).toHaveLength(1);
  });

  it('never pays for an expansion of an opaque dependency tree', async () => {
    const { exec, calls } = recordingExec(() => '!! node_modules/\n!! .pnpm/\n');
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(false);
    expect(calls.filter(isScoped)).toHaveLength(0);
  });

  it('protects when the scoped expansion itself fails', async () => {
    const exec = (async (_cmd: string, args: string[]) => {
      if (args.includes('--untracked-files=all')) throw new Error('fatal: bad pathspec');
      return { stdout: '!! dist/\n', stderr: '' };
    }) as unknown as ExecFileFn;
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(true);
  });

  it('passes core.quotePath=false so non-ASCII paths arrive literal', async () => {
    const { exec, calls } = recordingExec(() => '!! café/node_modules/\n');
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(false);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['-c', 'core.quotePath=false']),
    );
  });
});
