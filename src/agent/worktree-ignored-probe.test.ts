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
  probeNonRebuildableIgnoredFiles,
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
    // Nested machine-generated leaves. These read NON-rebuildable while the file
    // table was matched against the whole path, so one nested `.DS_Store` took a
    // worktree out of the sweep's reach permanently.
    'src/.DS_Store', 'packages/app/.eslintcache',
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
    // Non-dot-prefixed env leaves. The dot-anchored `/^\.env$/` missed these, so
    // they survived expansion and were reaped with the checkout.
    'dist/app.env', 'dist/prod.env', 'out/staging.env',
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
    for (const entry of ['npm-debug.log', 'debug.log', 'pnpm-debug.log', 'logs/debug.log']) {
      expect(isRebuildableIgnoredEntry(entry)).toBe(true);
    }
  });

  // `logs/` is `inspectable`, not `opaque`: an opaque verdict is never expanded,
  // so the sensitive-leaf table never ran on the leaves and `logs/.env` was
  // force-deleted with the checkout, unseen.
  const sensitiveUnderLogs = [
    'logs/.env', 'logs/app.env', 'logs/prod.key', 'logs/creds.pem',
    'logs/data.db', 'logs/id_rsa',
  ];
  for (const entry of sensitiveUnderLogs) {
    it(`treats ${entry} as NON-rebuildable despite the logs/ prefix`, () => {
      expect(isRebuildableIgnoredEntry(entry)).toBe(false);
    });
  }

  // Documented residual, pinned so a future reader sees it is a choice and not
  // an oversight: a nested leaf re-matches the `logs/` directory pattern and so
  // classifies `inspectable`, which is why a non-sensitive hand-kept log stays
  // reapable under `logs/` while the same filename at the repo root protects.
  // Closing this would require presuming nested leaves non-rebuildable, which is
  // exactly what would make every `dist/`-bearing worktree immortal.
  it('leaves the non-sensitive nested-log asymmetry in place', () => {
    expect(isRebuildableIgnoredEntry('decisions.log')).toBe(false);
    expect(isRebuildableIgnoredEntry('logs/decisions.log')).toBe(true);
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

  // Regression guard for the reaper-loss path: while `logs/` sat in the opaque
  // tier this expansion was never paid, so a `logs/` holding a secret read
  // "reapable" and the tree was force-removed with it. Asserting the scoped call
  // happened is the part that fails if `logs/` is ever moved back.
  it('expands a collapsed logs dir and protects when it hides a secret', async () => {
    const { exec, calls } = recordingExec((args) =>
      isScoped(args) ? '!! logs/run.log\n!! logs/.env\n' : '!! logs/\n',
    );
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(true);
    expect(calls.filter(isScoped)).toHaveLength(1);
  });

  it('expands a collapsed logs dir and reaps when it holds only log noise', async () => {
    const { exec, calls } = recordingExec((args) =>
      isScoped(args) ? '!! logs/debug.log\n!! logs/run.log\n' : '!! logs/\n',
    );
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(false);
    expect(calls.filter(isScoped)).toHaveLength(1);
  });

  it('passes core.quotePath=false so non-ASCII paths arrive literal', async () => {
    const { exec, calls } = recordingExec(() => '!! café/node_modules/\n');
    expect(await hasNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toBe(false);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['-c', 'core.quotePath=false']),
    );
  });
});

/**
 * A protect-on-git-failure and a protect-on-real-find are the same boolean, and
 * that ambiguity is how a permanently unreapable worktree stays invisible. These
 * pin that the verdict form distinguishes them, and that the scoped expansion
 * cannot turn "lots of output" into "git failed" via a 1MB buffer overflow.
 */
describe('probeNonRebuildableIgnoredFiles — verdict provenance', () => {
  it('reports a real find as non-rebuildable-entry', async () => {
    const exec = mockExec('!! local-notes.md\n');
    // `detail` names the offending entry: without it the caller can only say
    // "non-rebuildable ignored files (e.g. .env)", which reads as a finding
    // and sends the user hunting for a file that is not there.
    expect(await probeNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toEqual({
      protect: true,
      because: 'non-rebuildable-entry',
      detail: 'local-notes.md',
    });
  });

  it('reports a top-level git failure as git-failed, carrying the detail', async () => {
    const verdict = await probeNonRebuildableIgnoredFiles(throwingExec, '/tmp/wt');
    expect(verdict.protect).toBe(true);
    expect(verdict).toMatchObject({ because: 'git-failed' });
    if (verdict.protect && verdict.because === 'git-failed') {
      expect(verdict.detail).toContain('not a git repository');
    }
  });

  it('names the scoped directory when the EXPANSION is what failed', async () => {
    const exec = (async (_cmd: string, args: string[]) => {
      if (args.includes('--untracked-files=all')) throw new Error('stdout maxBuffer length exceeded');
      return { stdout: '!! dist/\n', stderr: '' };
    }) as unknown as ExecFileFn;
    const verdict = await probeNonRebuildableIgnoredFiles(exec, '/tmp/wt');
    if (verdict.protect && verdict.because === 'git-failed') {
      expect(verdict.detail).toContain('expanding dist/');
      expect(verdict.detail).toContain('maxBuffer');
    } else {
      throw new Error(`expected a git-failed verdict, got ${JSON.stringify(verdict)}`);
    }
  });

  it('reports no protection needed when everything is rebuildable', async () => {
    const exec = mockExec('!! node_modules/\n!! .afk-worktree-meta.json\n');
    expect(await probeNonRebuildableIgnoredFiles(exec, '/tmp/wt')).toEqual({ protect: false });
  });

  // Regression guard: an unbounded execFile REJECTS on overflow rather than
  // truncating, and every failure path here protects — so a missing maxBuffer
  // silently makes each large-build worktree immortal.
  it('raises maxBuffer and bounds the timeout on every git call', async () => {
    const opts: Array<Record<string, unknown> | undefined> = [];
    const exec = (async (_cmd: string, args: string[], o?: Record<string, unknown>) => {
      opts.push(o);
      return {
        stdout: args.includes('--untracked-files=all') ? '!! dist/app.js\n' : '!! dist/\n',
        stderr: '',
      };
    }) as unknown as ExecFileFn;
    await probeNonRebuildableIgnoredFiles(exec, '/tmp/wt');
    expect(opts).toHaveLength(2); // top-level + one scoped expansion
    for (const o of opts) {
      expect(o?.['maxBuffer']).toBe(64 * 1024 * 1024);
      expect(o?.['timeout']).toBe(10_000);
    }
  });

  it('still collapses to a boolean for the legacy surface', async () => {
    expect(await hasNonRebuildableIgnoredFiles(mockExec('!! local-notes.md\n'), '/tmp/wt')).toBe(true);
    expect(await hasNonRebuildableIgnoredFiles(mockExec('!! node_modules/\n'), '/tmp/wt')).toBe(false);
  });
});
