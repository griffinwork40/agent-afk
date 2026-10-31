/**
 * getSessionOutcomes — memoized per-session OutcomesV1 computation shared by
 * the run-receipt and outcome-store SessionEnd hooks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'afk-session-outcomes-')));
const savedHome = process.env['AFK_HOME'];
const savedState = process.env['AFK_STATE_DIR'];
process.env['AFK_HOME'] = home;
delete process.env['AFK_STATE_DIR'];

import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';
import { captureGitHead, writeSessionMeta } from '../session/session-meta.js';
import { getEffectLedgerPath } from '../../paths.js';
import { readEffectsForSession } from '../effect-ledger/store.js';
import { _resetSessionOutcomesCache, getSessionOutcomes, readEndHead } from './session-outcomes.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let repo: string;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'afk-session-outcomes-repo-')));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: base');
});

afterAll(() => {
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  if (savedState !== undefined) process.env['AFK_STATE_DIR'] = savedState;
  rmSyncRetry(home);
  rmSyncRetry(repo);
});

afterEach(() => _resetSessionOutcomesCache());

let n = 0;
async function startSession(): Promise<string> {
  const sessionId = `so-test-${Date.now()}-${n++}`;
  await writeSessionMeta({ v: 1, sessionId, model: 'm', cwd: repo, gitHead: captureGitHead(repo) });
  return sessionId;
}

function commit(msg: string): string {
  writeFileSync(join(repo, `${msg.replace(/\W/g, '_')}.txt`), msg);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('getSessionOutcomes', () => {
  it('lists commits made since session start (full sha, git_log source)', async () => {
    const sessionId = await startSession();
    const sha = commit('feat: during session');
    const o = await getSessionOutcomes(sessionId);
    expect(o).not.toBeNull();
    expect(o!.schemaVersion).toBe(1);
    expect(o!.cwd).toBe(repo);
    expect(o!.endHead).toBe(sha);
    expect(o!.commits[0]).toMatchObject({ sha, subject: 'feat: during session', source: 'git_log' });
  });

  it('memoizes one computation for both consumers regardless of order', async () => {
    const sessionId = await startSession();
    const a = getSessionOutcomes(sessionId);
    const b = getSessionOutcomes(sessionId);
    expect(a).toBe(b);
    // After both consumers read, the entry is evicted.
    expect(getSessionOutcomes(sessionId)).not.toBe(a);
  });

  it('merges PRs from effect-ledger rows for this sessionId only', async () => {
    const sessionId = await startSession();
    const row = (sid: string, url: string) => ({
      v: 1, id: `id-${url}`, idempotencyKey: 'k', operationType: 'bash_external',
      args: { command: 'gh pr create --fill' }, status: 'executed', sessionId: sid,
      timestamp: Date.now(), result: url,
    });
    mkdirSync(join(getEffectLedgerPath(), '..'), { recursive: true });
    writeFileSync(
      getEffectLedgerPath(),
      [row(sessionId, 'https://github.com/o/r/pull/1'), row('other', 'https://github.com/o/r/pull/2')]
        .map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    expect(await readEffectsForSession(sessionId)).toHaveLength(1);
    const o = await getSessionOutcomes(sessionId);
    expect(o!.prs.map((p) => p.url)).toEqual(['https://github.com/o/r/pull/1']);
  });

  it('resolves null (never rejects) when no cwd is known', async () => {
    await expect(getSessionOutcomes('so-test-missing-meta')).resolves.toBeNull();
  });

  it('resolves null when the total budget elapses', async () => {
    const sessionId = await startSession();
    await expect(getSessionOutcomes(sessionId, {}, { timeoutMs: 0 })).resolves.toBeNull();
  });

  it('falls back to ctx.cwd and null startHead without a sidecar', async () => {
    const o = await getSessionOutcomes('so-test-no-sidecar', { cwd: repo });
    expect(o).not.toBeNull();
    expect(o!.startHead).toBeNull();
    expect(o!.commits).toEqual([]);
  });

  it('readEndHead returns null outside a git repo', async () => {
    expect(await readEndHead(home)).toBeNull();
  });
});
