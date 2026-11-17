/**
 * Tests for issue #4954: stop attributing unrelated PR links and pulled
 * commits to a session.
 *
 * PR-link fix (Option B): compound commands (&&, ;, |, heredoc) must yield
 * `unknown` from prActionFromCommand / ledgerPrs so URLs in unrelated output
 * are not promoted to a mutating action.
 *
 * Commit-attribution fix (Option E): gitLogRange with `ledgerShas` annotates
 * each entry with `sessionAuthored: true/false` so callers can distinguish
 * commits the session made from commits that arrived via git pull/rebase.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';
import {
  isCompoundCommand,
  prActionFromCommand,
  ledgerPrs,
  settledEffects,
} from './outcomes-ledger.js';
import { gitLogRange } from './git-range.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ledgerRow(
  command: string,
  result: unknown,
  status = 'executed',
  id?: string,
): Record<string, unknown> {
  return {
    v: 1,
    id: id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: 'k',
    operationType: 'bash_external',
    args: { command },
    sessionId: 's',
    timestamp: 1,
    status,
    result,
  };
}

// ---------------------------------------------------------------------------
// PR-link fix: Option B — compound commands → unknown action
// ---------------------------------------------------------------------------

describe('isCompoundCommand', () => {
  it('detects && as compound', () => {
    expect(isCompoundCommand('gh pr create --fill && echo done')).toBe(true);
  });

  it('detects ; as compound', () => {
    expect(isCompoundCommand('cd /tmp; gh pr create --fill')).toBe(true);
  });

  it('detects | as compound', () => {
    expect(isCompoundCommand('gh pr create --fill | tee out.txt')).toBe(true);
  });

  it('detects << heredoc marker', () => {
    expect(isCompoundCommand('gh pr create --body-file <<EOF')).toBe(true);
  });

  it('returns false for a plain gh command', () => {
    expect(isCompoundCommand('gh pr create --fill')).toBe(false);
    expect(isCompoundCommand('gh pr merge 42 --merge')).toBe(false);
  });
});

describe('prActionFromCommand — compound commands yield unknown (issue #4954)', () => {
  it('returns unknown for gh pr create inside a compound command', () => {
    expect(prActionFromCommand('gh pr create --fill && echo done')).toBe('unknown');
  });

  it('returns unknown for gh pr merge inside a compound command', () => {
    expect(prActionFromCommand('gh pr merge 42 --merge; echo merged')).toBe('unknown');
  });

  it('returns unknown for gh pr edit piped through grep', () => {
    expect(prActionFromCommand('gh pr edit 10 --title t | grep url')).toBe('unknown');
  });

  it('still returns create for a plain gh pr create', () => {
    expect(prActionFromCommand('gh pr create --fill')).toBe('create');
  });

  it('still returns merge for a plain gh pr merge', () => {
    expect(prActionFromCommand('gh pr merge 42 --merge')).toBe('merge');
  });
});

describe('ledgerPrs — compound command URLs recorded as unknown (issue #4954)', () => {
  const prUrl = 'https://github.com/o/r/pull/999';

  it('records action=unknown when PR URL appears in compound-command output', () => {
    // Simulate a script that runs gh pr create AND other things in one shell call.
    // The URL in the result must not be credited as a 'create'.
    const effects = settledEffects([
      ledgerRow(
        `gh pr create --fill && gh pr view --json url`,
        `remote:\n${prUrl}`,
      ),
    ]);
    const out = ledgerPrs(effects);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe(prUrl);
    expect(out[0]!.action).toBe('unknown');
  });

  it('records action=unknown when URL appears in piped command output', () => {
    const effects = settledEffects([
      ledgerRow(`echo "${prUrl}" | cat`, `${prUrl}`),
    ]);
    const out = ledgerPrs(effects);
    expect(out).toHaveLength(1);
    expect(out[0]!.action).toBe('unknown');
  });

  it('still records create for a plain gh pr create result', () => {
    const effects = settledEffects([
      ledgerRow('gh pr create --fill', `remote:\n${prUrl}`),
    ]);
    const out = ledgerPrs(effects);
    expect(out).toEqual([{ url: prUrl, action: 'create' }]);
  });

  it('does not upgrade unknown from compound command over a prior create', () => {
    // First row: plain create (gets 'create').  Second row: compound (would be
    // 'unknown', which is weaker than 'create') — must not downgrade.
    const effects = settledEffects([
      ledgerRow('gh pr create --fill', `${prUrl}`),
      ledgerRow(`gh pr view --json url && echo`, `${prUrl}`),
    ]);
    const out = ledgerPrs(effects);
    expect(out).toHaveLength(1);
    expect(out[0]!.action).toBe('create');
  });
});

// ---------------------------------------------------------------------------
// Commit-attribution fix: Option E — sessionAuthored annotation
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('gitLogRange — sessionAuthored annotation (issue #4954)', () => {
  let repo: string;
  let base: string;
  let sessionSha: string;
  let pulledSha: string;

  beforeAll(() => {
    // Set up a repo that simulates "session made one commit, then pulled one".
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'afk-4954-')));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'commit.gpgsign', 'false');

    // base commit
    writeFileSync(join(repo, 'a.txt'), 'base');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'chore: base');
    base = git(repo, 'rev-parse', 'HEAD');

    // "pulled" commit — arrived via git pull, not authored by session
    writeFileSync(join(repo, 'b.txt'), 'pulled');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feat: pulled commit');
    pulledSha = git(repo, 'rev-parse', 'HEAD');

    // "session" commit — authored by this session
    writeFileSync(join(repo, 'c.txt'), 'session');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fix: session commit');
    sessionSha = git(repo, 'rev-parse', 'HEAD');

    repo = resolve(git(repo, 'rev-parse', '--show-toplevel'));
  });

  afterAll(() => {
    rmSyncRetry(repo);
  });

  it('marks sessionAuthored=true when sha is in ledgerShas', async () => {
    const ledgerShas = new Set([sessionSha]);
    const entries = await gitLogRange(repo, base, sessionSha, { ledgerShas });
    const session = entries.find((e) => e.sha === sessionSha);
    const pulled = entries.find((e) => e.sha === pulledSha);
    expect(session?.sessionAuthored).toBe(true);
    expect(pulled?.sessionAuthored).toBe(false);
  });

  it('marks sessionAuthored=true using abbreviated ledger SHA', async () => {
    // The ledger may store the 7-char short sha from git commit stdout.
    const shortSha = sessionSha.slice(0, 7);
    const ledgerShas = new Set([shortSha]);
    const entries = await gitLogRange(repo, base, sessionSha, { ledgerShas });
    const session = entries.find((e) => e.sha === sessionSha);
    expect(session?.sessionAuthored).toBe(true);
  });

  it('leaves sessionAuthored absent when no ledgerShas provided', async () => {
    const entries = await gitLogRange(repo, base, sessionSha);
    for (const e of entries) {
      expect(e.sessionAuthored).toBeUndefined();
    }
  });

  it('marks all commits sessionAuthored=false when ledgerShas is empty', async () => {
    const entries = await gitLogRange(repo, base, sessionSha, { ledgerShas: new Set() });
    for (const e of entries) {
      expect(e.sessionAuthored).toBe(false);
    }
  });
});
