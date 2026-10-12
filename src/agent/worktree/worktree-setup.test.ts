/**
 * Tests for the opt-in repo-declared worktree setup (#3601): no-declaration
 * no-op, success, failure, timeout, abort, invalid declaration, ordering
 * (meta written before setup starts), and isolation of setup errors from the
 * LOCK_CONTENTION retry path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runWorktreeSetup,
  defaultSetupCommandRunner,
  describeWorktreeSetupFailure,
  type SetupCommandRunner,
} from './worktree-setup.js';
import { createManagedWorktree, createIsolatedWorktree } from '../tools/handlers/worktree-managed.js';
import type { ExecFileFn } from './worktree-sweep.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wt-setup-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function declare(root: string, decl: unknown): Promise<void> {
  await fs.mkdir(join(root, '.afk'), { recursive: true });
  await fs.writeFile(join(root, '.afk', 'worktree-setup.json'), typeof decl === 'string' ? decl : JSON.stringify(decl));
}

function recordingRunner(outcomes: Record<string, Awaited<ReturnType<SetupCommandRunner>>> = {}) {
  const ran: string[] = [];
  const runner: SetupCommandRunner = async (command) => {
    ran.push(command);
    return outcomes[command] ?? { kind: 'ok' };
  };
  return { ran, runner };
}

describe('runWorktreeSetup', () => {
  it('no declaration → status none and nothing runs', async () => {
    const { ran, runner } = recordingRunner();
    const result = await runWorktreeSetup({ worktreePath: dir, runCommand: runner });
    expect(result).toEqual({ status: 'none' });
    expect(ran).toEqual([]);
    expect(describeWorktreeSetupFailure(result, dir)).toBeUndefined();
  });

  it('runs declared commands in order and reports ok', async () => {
    await declare(dir, { commands: ['a', 'b'] });
    const { ran, runner } = recordingRunner();
    const result = await runWorktreeSetup({ worktreePath: dir, runCommand: runner });
    expect(result).toEqual({ status: 'ok', completed: ['a', 'b'] });
    expect(ran).toEqual(['a', 'b']);
  });

  it('stops at the first failure and names the exact command', async () => {
    await declare(dir, { commands: ['a', 'b', 'c'] });
    const { ran, runner } = recordingRunner({ b: { kind: 'failed', detail: 'exit 1' } });
    const result = await runWorktreeSetup({ worktreePath: dir, runCommand: runner });
    expect(result).toEqual({ status: 'failed', command: 'b', detail: 'exit 1', completed: ['a'] });
    expect(ran).toEqual(['a', 'b']);
    expect(describeWorktreeSetupFailure(result, dir)).toContain('`b` failed');
  });

  it('reports invalid declarations without running anything', async () => {
    await declare(dir, '{not json');
    const { ran, runner } = recordingRunner();
    const result = await runWorktreeSetup({ worktreePath: dir, runCommand: runner });
    expect(result.status).toBe('invalid');
    expect(ran).toEqual([]);
    await declare(dir, { commands: [''] });
    expect((await runWorktreeSetup({ worktreePath: dir, runCommand: runner })).status).toBe('invalid');
  });

  it('honors timeoutMs with the real runner (process killed, status timeout)', async () => {
    await declare(dir, { commands: ['sleep 5'], timeoutMs: 200 });
    const started = Date.now();
    const result = await runWorktreeSetup({ worktreePath: dir });
    expect(result.status).toBe('timeout');
    expect(result.command).toBe('sleep 5');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('honors the abort signal with the real runner', async () => {
    await declare(dir, { commands: ['sleep 5', 'echo never'] });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const result = await runWorktreeSetup({ worktreePath: dir, signal: ac.signal });
    expect(result.status).toBe('aborted');
    expect(result.command).toBe('sleep 5');
  });

  it('real runner: success runs in the worktree cwd; non-zero exit is a failure', async () => {
    expect(await defaultSetupCommandRunner('echo hi > marker.txt', { cwd: dir, timeoutMs: 5_000 })).toEqual({ kind: 'ok' });
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true);
    const failed = await defaultSetupCommandRunner('echo boom >&2; exit 3', { cwd: dir, timeoutMs: 5_000 });
    expect(failed.kind).toBe('failed');
    expect(failed.kind === 'failed' ? failed.detail : '').toContain('exit 3');
  });
});

/** Mock git whose `worktree add` materializes the tree (optionally with a declaration). */
function gitMock(wtPath: string, opts: { declaration?: unknown; addError?: string } = {}) {
  const calls: string[][] = [];
  const fn = (async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes('add')) {
      if (opts.addError !== undefined) throw new Error(opts.addError);
      await fs.mkdir(wtPath, { recursive: true });
      if (opts.declaration !== undefined) await declare(wtPath, opts.declaration);
    }
    if (args.includes('rev-parse')) return { stdout: 'sha-1\n', stderr: '' };
    return { stdout: '', stderr: '' };
  }) as ExecFileFn;
  return { fn, calls };
}

describe('createManagedWorktree + setup', () => {
  it('no declaration: result shape is unchanged (no setup key)', async () => {
    const wt = join(dir, '.afk-worktrees', 'a');
    const { fn } = gitMock(wt);
    const info = await createManagedWorktree({ execFile: fn, repoRoot: dir, worktreePath: wt, branch: 'afk/a', baseRef: 'HEAD' });
    expect(info).toEqual({ path: wt, branch: 'afk/a', baseRef: 'HEAD', baseSha: 'sha-1' });
  });

  it('writes meta BEFORE setup starts', async () => {
    const wt = join(dir, '.afk-worktrees', 'b');
    const { fn } = gitMock(wt, { declaration: { commands: ['install'] } });
    let metaSeenAtSetupStart: boolean | undefined;
    const runner: SetupCommandRunner = async () => {
      metaSeenAtSetupStart = existsSync(join(wt, '.afk-worktree-meta.json'));
      return { kind: 'ok' };
    };
    const info = await createManagedWorktree({ execFile: fn, repoRoot: dir, worktreePath: wt, branch: 'afk/b', baseRef: 'HEAD', setupRunner: runner });
    expect(metaSeenAtSetupStart).toBe(true);
    expect(info.setup).toEqual({ status: 'ok', completed: ['install'] });
  });

  it('setup failure never fails the create and is reported on the result', async () => {
    const wt = join(dir, '.afk-worktrees', 'c');
    const { fn } = gitMock(wt, { declaration: { commands: ['install'] } });
    const runner: SetupCommandRunner = async () => ({ kind: 'failed', detail: 'exit 1' });
    const info = await createManagedWorktree({ execFile: fn, repoRoot: dir, worktreePath: wt, branch: 'afk/c', baseRef: 'HEAD', setupRunner: runner });
    expect(info.path).toBe(wt);
    expect(info.setup?.status).toBe('failed');
    expect(info.setup?.command).toBe('install');
  });

  it('a lock-shaped setup failure never re-runs `git worktree add`', async () => {
    const wt = join(dir, '.afk-worktrees', 'iso-x');
    const { fn, calls } = gitMock(wt, { declaration: { commands: ['install'] } });
    const runner: SetupCommandRunner = async () => ({ kind: 'failed', detail: 'fatal: Unable to create index.lock: File exists' });
    const info = await createIsolatedWorktree({ execFile: fn, cwd: dir, slugHint: 'iso-x', baseRef: 'HEAD', setupRunner: runner });
    expect(info.setup?.status).toBe('failed');
    expect(calls.filter((a) => a.includes('add'))).toHaveLength(1);
  });
});

describe('worktree tool create surfaces setup outcome', () => {
  it('names the failed command in the create note', async () => {
    const { createWorktreeHandler } = await import('../tools/handlers/worktree.js');
    const wt = join(dir, '.afk-worktrees', 'tool');
    const { fn } = gitMock(wt, { declaration: { commands: ['exit 7'] } });
    const execFile = (async (file: string, args: string[]) => {
      if (args.includes('--git-common-dir')) return { stdout: join(dir, '.git') + '\n', stderr: '' };
      if (args.includes('list')) return { stdout: '', stderr: '' };
      return fn(file, args);
    }) as ExecFileFn;
    const handler = createWorktreeHandler(dir, { execFile });
    const result = await handler({ action: 'create', name: 'tool', base: 'HEAD' }, new AbortController().signal);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content) as { path: string; note: string };
    expect(body.path).toBe(wt);
    expect(body.note).toContain('`exit 7` failed');
  });
});
