import { describe, it, expect } from 'vitest';
import {
  settledEffects,
  repoFromCommand,
  ledgerCommits,
  ledgerPrs,
  ledgerServices,
  prActionFromCommand,
  addPr,
} from './outcomes-ledger.js';
import type { OutcomePr } from './outcomes-v1.schema.js';

const CWD = '/repo/proj';

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
// settledEffects
// ---------------------------------------------------------------------------
describe('settledEffects', () => {
  it('collapses rows by id (last wins) and drops pending/failed', () => {
    const id = 'abc';
    const rows = [
      ledgerRow('git commit -m x', '', 'pending', id),
      ledgerRow('git commit -m x', '[main aaa1111] done', 'executed', id),
    ];
    const out = settledEffects(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.result).toContain('aaa1111');
  });

  it('deduplicates id-less rows by content', () => {
    const row = { status: 'executed', args: { command: 'echo hi' }, result: 'hi' };
    const out = settledEffects([row, { ...row }, row]);
    expect(out).toHaveLength(1);
  });

  it('skips malformed rows gracefully', () => {
    const out = settledEffects([null, 42, 'garbage', {}, { status: 'executed' }]);
    expect(out).toEqual([]);
  });

  it('skips rows with non-string or empty command', () => {
    const out = settledEffects([
      { id: 'a', status: 'executed', args: { command: 7 } },
      { id: 'b', status: 'executed', args: { command: '' } },
      { id: 'c', status: 'executed', args: 'not-an-object' },
    ]);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// repoFromCommand
// ---------------------------------------------------------------------------
describe('repoFromCommand', () => {
  it('extracts a leading cd with &&', () => {
    expect(repoFromCommand('cd /Users/x/wt && git commit', CWD)).toBe('/Users/x/wt');
  });

  it('extracts a leading cd with ;', () => {
    expect(repoFromCommand('cd /other; git add .', CWD)).toBe('/other');
  });

  it('extracts quoted paths', () => {
    expect(repoFromCommand('cd "/path with spaces" && git add', CWD)).toBe('/path with spaces');
    expect(repoFromCommand("cd '/single' && ls", CWD)).toBe('/single');
  });

  it('resolves relative cd targets against cwd', () => {
    expect(repoFromCommand('cd sub/dir && git commit', CWD)).toBe('/repo/proj/sub/dir');
  });

  it('falls back to cwd when no cd or tilde/env-var path', () => {
    expect(repoFromCommand('git commit -m x', CWD)).toBe(CWD);
    expect(repoFromCommand('cd ~/foo && git commit', CWD)).toBe(CWD);
    expect(repoFromCommand('cd $HOME/x && git commit', CWD)).toBe(CWD);
  });
});

// ---------------------------------------------------------------------------
// COMMIT_SUMMARY_RE / ledgerCommits
// ---------------------------------------------------------------------------
describe('ledgerCommits', () => {
  it('parses [branch sha] subject from git commit stdout', () => {
    const effects = settledEffects([
      ledgerRow('git commit -m "feat"', '[main abc1234] feat: new thing'),
    ]);
    const out = ledgerCommits(effects, CWD);
    expect(out).toEqual([{ sha: 'abc1234', repo: CWD, subject: 'feat: new thing', source: 'effect_ledger' }]);
  });

  it('parses root-commit format', () => {
    const effects = settledEffects([
      ledgerRow('git commit -m init', '[main (root-commit) 0abcdef] chore: initial'),
    ]);
    expect(ledgerCommits(effects, CWD)[0]!.sha).toBe('0abcdef');
  });

  it('parses detached HEAD format', () => {
    const effects = settledEffects([
      ledgerRow('git commit -m x', '[detached HEAD ff00112] fix: detached'),
    ]);
    expect(ledgerCommits(effects, CWD)[0]!.subject).toBe('fix: detached');
  });

  it('upgrades a short sha with a full rev-parse sha in the same result', () => {
    const full = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const effects = settledEffects([
      ledgerRow('git commit -m x && git rev-parse HEAD', `[main a1b2c3d] subj\n${full}`),
    ]);
    expect(ledgerCommits(effects, CWD)[0]!.sha).toBe(full);
  });

  it('falls back to git log --oneline when commit ran with -q', () => {
    const effects = settledEffects([
      ledgerRow('git commit -q -m x && git log --oneline -1', '5ee66d7 fix: silent commit'),
    ]);
    const out = ledgerCommits(effects, CWD);
    expect(out).toEqual([{ sha: '5ee66d7', repo: CWD, subject: 'fix: silent commit', source: 'effect_ledger' }]);
  });

  it('rejects git commit-tree (negative lookahead)', () => {
    const effects = settledEffects([
      ledgerRow('git commit-tree abc', '[main 2222222] not a commit'),
    ]);
    expect(ledgerCommits(effects, CWD)).toEqual([]);
  });

  it('returns [] for empty result', () => {
    const effects = settledEffects([ledgerRow('git commit -m x', '')]);
    expect(ledgerCommits(effects, CWD)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// prActionFromCommand / addPr / ledgerPrs
// ---------------------------------------------------------------------------
describe('prActionFromCommand', () => {
  it.each([
    ['gh pr create --fill', 'create'],
    ['gh pr merge 42 --merge', 'merge'],
    ['gh pr edit 10 --title t', 'update'],
    ['gh pr comment 5 --body hi', 'update'],
    ['gh pr review 7 --approve', 'update'],
    ['gh pr view 9 --json url', 'unknown'],
    ['echo hello', 'unknown'],
  ] as const)('%s → %s', (cmd, expected) => {
    expect(prActionFromCommand(cmd)).toBe(expected);
  });
});

describe('addPr', () => {
  it('adds a new URL', () => {
    const list: OutcomePr[] = [];
    addPr(list, { url: 'https://github.com/o/r/pull/1', action: 'create' });
    expect(list).toHaveLength(1);
  });

  it('upgrades to a stronger action for a repeated URL', () => {
    const list: OutcomePr[] = [{ url: 'https://github.com/o/r/pull/1', action: 'update' }];
    addPr(list, { url: 'https://github.com/o/r/pull/1', action: 'merge' });
    expect(list[0]!.action).toBe('merge');
  });

  it('does not downgrade action', () => {
    const list: OutcomePr[] = [{ url: 'https://github.com/o/r/pull/1', action: 'merge' }];
    addPr(list, { url: 'https://github.com/o/r/pull/1', action: 'unknown' });
    expect(list[0]!.action).toBe('merge');
  });
});

describe('ledgerPrs', () => {
  it('extracts PR URLs from result text and dedupes by url', () => {
    const url = 'https://github.com/o/r/pull/437';
    const effects = settledEffects([
      ledgerRow('gh pr create --fill', `remote:\n${url}`),
      ledgerRow('gh pr comment 437 --body hi', `${url}#issuecomment-1`),
    ]);
    const out = ledgerPrs(effects);
    expect(out).toEqual([{ url, action: 'create' }]);
  });

  it('parses Merged pull request ref from gh pr merge stdout', () => {
    const effects = settledEffects([
      ledgerRow('gh pr merge 316 --merge', '✓ Merged pull request o/r#316 (title)'),
    ]);
    expect(ledgerPrs(effects)).toEqual([
      { url: 'https://github.com/o/r/pull/316', action: 'merge' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ledgerServices
// ---------------------------------------------------------------------------
describe('ledgerServices', () => {
  it('extracts afk service actions', () => {
    const effects = settledEffects([
      ledgerRow('afk service install telegram && afk service start daemon', 'ok'),
      ledgerRow('afk service uninstall telegram', 'ok'),
    ]);
    expect(ledgerServices(effects)).toEqual([
      { name: 'telegram', action: 'install' },
      { name: 'daemon', action: 'start' },
      { name: 'telegram', action: 'uninstall' },
    ]);
  });

  it('dedupes identical name+action pairs', () => {
    const effects = settledEffects([
      ledgerRow('afk service start telegram', 'ok'),
      ledgerRow('afk service start telegram', 'ok'),
    ]);
    expect(ledgerServices(effects)).toHaveLength(1);
  });

  it('defaults name to unknown when missing', () => {
    const effects = settledEffects([ledgerRow('afk service restart', 'ok')]);
    expect(ledgerServices(effects)).toEqual([{ name: 'unknown', action: 'restart' }]);
  });
});
