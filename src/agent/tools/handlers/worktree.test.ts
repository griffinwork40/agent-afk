/**
 * Tests for the `worktree` lifecycle tool handler.
 *
 * Uses a mocked ExecFileFn (same pattern as worktree-sweep.test.ts) so no
 * real git operations run. Each test verifies the guard/validation logic
 * and the exact git argv the handler emits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createWorktreeHandler } from './worktree.js';
import type { ExecFileFn } from '../../worktree-sweep.js';

const SIGNAL = new AbortController().signal;

interface Call { file: string; args: string[] }

function makeMock(
  responder: (call: Call) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string },
): ExecFileFn & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (file: string, args: string[]) => {
    const call = { file, args };
    calls.push(call);
    return responder(call);
  }) as ExecFileFn & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

/** Porcelain block for `git worktree list --porcelain`. */
function block(path: string, opts?: { branch?: string; locked?: boolean }): string {
  const lines = [`worktree ${path}`, 'HEAD abc123'];
  if (opts?.branch) lines.push(`branch ${opts.branch}`);
  if (opts?.locked) lines.push('locked');
  return lines.join('\n');
}

let repoRoot: string;
let afkRoot: string;

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'wt-handler-'));
  afkRoot = join(repoRoot, '.afk-worktrees');
  await fs.mkdir(afkRoot, { recursive: true });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/** Standard responder: repo-root resolution + a porcelain listing. */
function standardResponder(porcelain: string, overrides?: (call: Call) => { stdout: string; stderr: string } | undefined) {
  return (call: Call) => {
    if (overrides) {
      const hit = overrides(call);
      if (hit) return hit;
    }
    if (call.args.includes('--git-common-dir')) {
      return { stdout: `${repoRoot}/.git\n`, stderr: '' };
    }
    if (call.args.includes('list') && call.args.includes('--porcelain')) {
      return { stdout: porcelain, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('worktree handler — input validation', () => {
  it('rejects non-object input', async () => {
    const handler = createWorktreeHandler(repoRoot, { execFile: makeMock(standardResponder('')) });
    const result = await handler('nope', SIGNAL);
    expect(result.isError).toBe(true);
  });

  it('rejects unknown action', async () => {
    const handler = createWorktreeHandler(repoRoot, { execFile: makeMock(standardResponder('')) });
    const result = await handler({ action: 'frobnicate' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('action must be one of');
  });

  it('create requires name', async () => {
    const handler = createWorktreeHandler(repoRoot, { execFile: makeMock(standardResponder('')) });
    const result = await handler({ action: 'create' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('name required');
  });

  it('keep/release/remove require path', async () => {
    const handler = createWorktreeHandler(repoRoot, { execFile: makeMock(standardResponder('')) });
    for (const action of ['keep', 'release', 'remove']) {
      const result = await handler({ action }, SIGNAL);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('path required');
    }
  });
});

describe('worktree handler — create', () => {
  it('creates under .afk-worktrees/ with sanitized slug, branch prefix, and meta', async () => {
    const wtPath = join(afkRoot, 'my-feature');
    const mock = makeMock(standardResponder(block(repoRoot), (call) => {
      if (call.args.includes('add')) {
        // Simulate git creating the dir so the meta write has a target.
        // (mkdir synchronously inside the responder.)
        return fs.mkdir(wtPath, { recursive: true }).then(() => ({ stdout: '', stderr: '' }));
      }
      if (call.args.includes('rev-parse') && call.args.includes('HEAD')) {
        return { stdout: 'base-sha-123\n', stderr: '' };
      }
      return undefined;
    }));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'create', name: 'My Feature!' }, SIGNAL);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(String(result.content)) as { path: string; branch: string };
    expect(parsed.path).toBe(wtPath);
    expect(parsed.branch).toBe('afk/my-feature');

    // git worktree add argv shape
    const addCall = mock.calls.find((c) => c.args.includes('add'));
    expect(addCall?.args).toEqual([
      '-C', repoRoot, 'worktree', 'add', '-b', 'afk/my-feature', wtPath, 'HEAD',
    ]);

    // Meta written with owner 'agent' + pid
    const metaRaw = await fs.readFile(join(wtPath, '.afk-worktree-meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;
    expect(meta['owner']).toBe('agent');
    expect(meta['pid']).toBe(process.pid);
    expect(meta['baseSha']).toBe('base-sha-123');
    expect(typeof meta['createdAt']).toBe('string');
  });

  it('refuses when a worktree already exists at the target path', async () => {
    const wtPath = join(afkRoot, 'taken');
    const mock = makeMock(standardResponder(`${block(repoRoot)}\n\n${block(wtPath)}\n`));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'create', name: 'taken' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('already exists');
  });

  it('rejects a name that sanitizes to empty', async () => {
    const handler = createWorktreeHandler(repoRoot, { execFile: makeMock(standardResponder('')) });
    const result = await handler({ action: 'create', name: '///' }, SIGNAL);
    expect(result.isError).toBe(true);
  });

  it('rejects a short-flag-like base (-x)', async () => {
    const mock = makeMock(standardResponder(block(repoRoot)));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'create', name: 'evil2', base: '-x' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
  });

  it('rejects a name containing .. path-traversal segments', async () => {
    const mock = makeMock(standardResponder(block(repoRoot)));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'create', name: '../../etc' }, SIGNAL);
    // sanitizeSlug strips slashes/dots into a plain segment, so this either
    // rejects outright or creates a harmless slug confined to afkRoot — either
    // way it must never land outside .afk-worktrees/.
    if (!result.isError) {
      const parsed = JSON.parse(String(result.content)) as { path: string };
      expect(parsed.path.startsWith(afkRoot + sep)).toBe(true);
    }
  });

  it('rejects a flag-like base ref before git worktree add', async () => {
    const mock = makeMock(standardResponder(block(repoRoot)));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler(
      { action: 'create', name: 'safe-name', base: '--upload-pack=evil' },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('base must be a git ref');
    expect(mock.calls.some((c) => c.args.includes('add'))).toBe(false);
  });
});

describe('worktree handler — keep / release', () => {
  it('locks a managed worktree with an afk-prefixed reason', async () => {
    const wtPath = join(afkRoot, 'important');
    const mock = makeMock(standardResponder(`${block(repoRoot)}\n\n${block(wtPath)}\n`));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler(
      { action: 'keep', path: 'important', reason: 'unmerged spike' },
      SIGNAL,
    );
    expect(result.isError).toBeUndefined();
    const lockCall = mock.calls.find((c) => c.args.includes('lock'));
    expect(lockCall?.args).toEqual([
      '-C', repoRoot, 'worktree', 'lock', '--reason', 'afk: unmerged spike', wtPath,
    ]);
  });

  it('refuses paths outside .afk-worktrees/', async () => {
    const mock = makeMock(standardResponder(block(repoRoot)));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'keep', path: '/tmp/elsewhere' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the afk-managed worktree root');
    expect(mock.calls.some((c) => c.args.includes('lock'))).toBe(false);
  });

  it('refuses unregistered worktrees', async () => {
    const mock = makeMock(standardResponder(block(repoRoot)));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'keep', path: 'ghost' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No registered git worktree');
  });

  it('refuses a relative .. path-traversal escaping .afk-worktrees/', async () => {
    const mock = makeMock(standardResponder(block(repoRoot)));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'keep', path: '../../etc' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the afk-managed worktree root');
    expect(mock.calls.some((c) => c.args.includes('lock'))).toBe(false);
  });

  it('release unlocks a managed worktree', async () => {
    const wtPath = join(afkRoot, 'kept');
    const mock = makeMock(standardResponder(`${block(repoRoot)}\n\n${block(wtPath, { locked: true })}\n`));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'release', path: 'kept' }, SIGNAL);
    expect(result.isError).toBeUndefined();
    const unlockCall = mock.calls.find((c) => c.args.includes('unlock'));
    expect(unlockCall?.args).toEqual(['-C', repoRoot, 'worktree', 'unlock', wtPath]);
  });
});

describe('worktree handler — remove guards', () => {
  it('refuses a locked worktree', async () => {
    const wtPath = join(afkRoot, 'locked-wt');
    const mock = makeMock(standardResponder(`${block(repoRoot)}\n\n${block(wtPath, { locked: true })}\n`));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'remove', path: 'locked-wt' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('locked');
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  it('refuses a locked worktree even when force: true is passed (lock check wins)', async () => {
    const wtPath = join(afkRoot, 'locked-force-wt');
    const mock = makeMock(standardResponder(`${block(repoRoot)}\n\n${block(wtPath, { locked: true })}\n`));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'remove', path: 'locked-force-wt', force: true }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('locked');
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  it('refuses a relative .. path-traversal escaping .afk-worktrees/', async () => {
    const mock = makeMock(standardResponder(block(repoRoot)));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'remove', path: '../../etc' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside the afk-managed worktree root');
    expect(mock.calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  it('refuses a dirty worktree without force', async () => {
    const wtPath = join(afkRoot, 'dirty-wt');
    const mock = makeMock(standardResponder(`${block(repoRoot)}\n\n${block(wtPath)}\n`, (call) => {
      if (call.args.includes('status')) return { stdout: ' M file.ts\n', stderr: '' };
      return undefined;
    }));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'remove', path: 'dirty-wt' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('uncommitted changes');
  });

  it('refuses a worktree with commits ahead without force', async () => {
    const wtPath = join(afkRoot, 'ahead-wt');
    await fs.mkdir(wtPath, { recursive: true });
    await fs.writeFile(
      join(wtPath, '.afk-worktree-meta.json'),
      JSON.stringify({ owner: 'agent', createdAt: new Date().toISOString(), baseSha: 'base123' }),
    );
    const mock = makeMock(standardResponder(`${block(repoRoot)}\n\n${block(wtPath)}\n`, (call) => {
      if (call.args.includes('status')) return { stdout: '', stderr: '' };
      if (call.args.includes('rev-parse') && call.args.includes('HEAD') && call.args.includes(wtPath)) {
        return { stdout: 'tip456\n', stderr: '' };
      }
      if (call.args.includes('rev-list')) return { stdout: '2\n', stderr: '' };
      return undefined;
    }));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'remove', path: 'ahead-wt' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('commit(s) ahead');
  });

  it('removes a clean worktree and preserves the branch', async () => {
    const wtPath = join(afkRoot, 'clean-wt');
    const mock = makeMock(
      standardResponder(`${block(repoRoot)}\n\n${block(wtPath, { branch: 'refs/heads/afk/clean-wt' })}\n`),
    );
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'remove', path: 'clean-wt' }, SIGNAL);
    expect(result.isError).toBeUndefined();
    const removeCall = mock.calls.find((c) => c.args.includes('remove'));
    expect(removeCall?.args).toEqual(['-C', repoRoot, 'worktree', 'remove', wtPath]);
    // No --force, no branch -d.
    expect(removeCall?.args).not.toContain('--force');
    expect(mock.calls.some((c) => c.args.includes('branch') && c.args.includes('-d'))).toBe(false);
  });

  it('force removes a dirty worktree with --force', async () => {
    const wtPath = join(afkRoot, 'force-wt');
    const mock = makeMock(standardResponder(`${block(repoRoot)}\n\n${block(wtPath)}\n`, (call) => {
      if (call.args.includes('status')) return { stdout: ' M dirty.ts\n', stderr: '' };
      return undefined;
    }));
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'remove', path: 'force-wt', force: true }, SIGNAL);
    expect(result.isError).toBeUndefined();
    const removeCall = mock.calls.find((c) => c.args.includes('remove'));
    expect(removeCall?.args).toContain('--force');
  });
});

describe('worktree handler — errors surface as isError', () => {
  it('git failures return isError instead of throwing', async () => {
    const wtPath = join(afkRoot, 'boom');
    const mock = makeMock((call) => {
      if (call.args.includes('--git-common-dir')) return { stdout: `${repoRoot}/.git\n`, stderr: '' };
      if (call.args.includes('list') && call.args.includes('--porcelain')) {
        return { stdout: `${block(repoRoot)}\n\n${block(wtPath)}\n`, stderr: '' };
      }
      if (call.args.includes('lock')) throw new Error('git exploded');
      return { stdout: '', stderr: '' };
    });
    const handler = createWorktreeHandler(repoRoot, { execFile: mock });
    const result = await handler({ action: 'keep', path: 'boom' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('git exploded');
  });

  it('unresolvable repo root returns isError', async () => {
    const mock = makeMock(() => { throw new Error('not a git repo'); });
    const handler = createWorktreeHandler('/nowhere', { execFile: mock });
    const result = await handler({ action: 'list' }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Cannot resolve git repo root');
  });
});
