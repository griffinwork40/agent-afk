import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';
import { gitLogRange } from './git-range.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('gitLogRange', () => {
  let repo: string;
  let plain: string;
  let first: string;
  let second: string;
  let third: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'afk-git-range-')));
    plain = realpathSync(mkdtempSync(join(tmpdir(), 'afk-git-range-plain-')));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');
    for (const [i, msg] of ['chore: initial', 'feat: second\n\nbody line', 'fix: third'].entries()) {
      writeFileSync(join(repo, `f${i}.txt`), msg);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', msg);
    }
    [third, second, first] = git(repo, 'log', '--format=%H').split('\n') as [string, string, string];
  });

  afterAll(() => {
    rmSyncRetry(repo);
    rmSyncRetry(plain);
  });

  it('lists commits in startHead..endHead newest first with first-line subjects', async () => {
    expect(await gitLogRange(repo, first, third)).toEqual([
      { sha: third, subject: 'fix: third', repo },
      { sha: second, subject: 'feat: second', repo },
    ]);
  });

  it('defaults endHead to HEAD and accepts a short startHead', async () => {
    const out = await gitLogRange(repo, second.slice(0, 7), null);
    expect(out.map((c) => c.sha)).toEqual([third]);
  });

  it('returns [] for a null startHead or an empty range', async () => {
    expect(await gitLogRange(repo, null, third)).toEqual([]);
    expect(await gitLogRange(repo, third, third)).toEqual([]);
  });

  it('returns [] (never throws) for a non-git dir, unknown sha, bad input, or missing dir', async () => {
    expect(await gitLogRange(plain, first, third)).toEqual([]);
    expect(await gitLogRange(repo, 'deadbeefdeadbeef', null)).toEqual([]);
    expect(await gitLogRange(repo, '--all', null)).toEqual([]);
    expect(await gitLogRange(join(plain, 'nope'), first, third, { timeoutMs: 2000 })).toEqual([]);
  });
});
