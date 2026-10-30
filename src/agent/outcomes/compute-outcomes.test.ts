import { describe, it, expect } from 'vitest';
import { computeOutcomes, type ComputeOutcomesInput } from './compute-outcomes.js';
import { OutcomesV1Schema } from './outcomes-v1.schema.js';
import type { ToolEventInput } from '../facets/schema.js';

const CWD = '/repo/proj';
const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function base(over: Partial<ComputeOutcomesInput> = {}): ComputeOutcomesInput {
  return {
    cwd: CWD,
    startHead: null,
    endHead: null,
    ledgerEntries: [],
    toolEvents: [],
    lastAssistantMessage: null,
    ...over,
  };
}

let n = 0;
/** Redacted shape of a real ~/.afk/state/effect-ledger.jsonl row pair (pending → executed). */
function ledger(command: string, result: unknown, status = 'executed'): unknown[] {
  const id = `id-${++n}`;
  const row = { v: 1, id, idempotencyKey: `k${n}`, operationType: 'bash_external', args: { command }, sessionId: 's', timestamp: 1 };
  return [{ ...row, status: 'pending' }, { ...row, status, result }];
}

function ev(toolName: string, input: Record<string, unknown>, extra: Partial<ToolEventInput> = {}): ToolEventInput {
  return { toolName, inputRaw: JSON.stringify(input), ...extra };
}

describe('computeOutcomes', () => {
  it('empty input yields an empty, schema-valid record', () => {
    const out = computeOutcomes(base({ startHead: 'abc1234', endHead: 'def5678' }));
    expect(OutcomesV1Schema.parse(out)).toEqual({
      schemaVersion: 1, cwd: CWD, startHead: 'abc1234', endHead: 'def5678',
      commits: [], prs: [], filesChanged: [], filesChangedTruncated: false,
      schedules: [], services: [], terminalState: null,
    });
  });

  it('commits from git_log', () => {
    const out = computeOutcomes(base({ gitLog: [{ sha: FULL, subject: 'feat: x', repo: CWD }] }));
    expect(out.commits).toEqual([{ sha: FULL, subject: 'feat: x', repo: CWD, source: 'git_log' }]);
  });

  it('commits from ledger `git commit` stdout, repo from leading cd', () => {
    const out = computeOutcomes(base({
      ledgerEntries: [
        ...ledger('cd /Users/x/wt/pr36-fix && git add -A && git commit -m "fix"', '[afk/pr36-fix 3454e70] fix(#29): review fixes\n 2 files changed'),
        ...ledger('git commit -q -m x && git log --oneline -1', '5ee66d7 fix(pr-316): address review feedback\nOPEN'),
        ...ledger('git commit -m "root"', '[main (root-commit) 0abcdef] chore: initial'),
      ],
    }));
    expect(out.commits).toEqual([
      { sha: '3454e70', repo: '/Users/x/wt/pr36-fix', subject: 'fix(#29): review fixes', source: 'effect_ledger' },
      { sha: '5ee66d7', repo: CWD, subject: 'fix(pr-316): address review feedback', source: 'effect_ledger' },
      { sha: '0abcdef', repo: CWD, subject: 'chore: initial', source: 'effect_ledger' },
    ]);
  });

  it('upgrades a short ledger sha with a full rev-parse sha in the same result', () => {
    const out = computeOutcomes(base({
      ledgerEntries: ledger('git commit -m x && git rev-parse HEAD', `[main a1b2c3d] subj\n${FULL}`),
    }));
    expect(out.commits[0]?.sha).toBe(FULL);
  });

  it('dedupe precedence: git_log wins over a short ledger sha that prefixes it', () => {
    const out = computeOutcomes(base({
      gitLog: [{ sha: FULL, subject: 'authoritative', repo: '/r' }],
      ledgerEntries: ledger('git commit -m x', '[main a1b2c3d] ledger subject'),
    }));
    expect(out.commits).toEqual([{ sha: FULL, subject: 'authoritative', repo: '/r', source: 'git_log' }]);
  });

  it('ignores failed/pending ledger rows and git commit-tree', () => {
    const out = computeOutcomes(base({
      ledgerEntries: [
        ...ledger('git commit -m x', '[main 1111111] failed one', 'failed'),
        { v: 1, id: 'p', status: 'pending', args: { command: 'git commit -m y' } },
        ...ledger('git commit-tree abc', '[main 2222222] not a commit'),
      ],
    }));
    expect(out.commits).toEqual([]);
  });

  it('PRs from ledger results with action inferred from the gh verb, deduped by url', () => {
    const url = 'https://github.com/o/r/pull/437';
    const out = computeOutcomes(base({
      ledgerEntries: [
        ...ledger('git push && gh pr create --fill', `remote: \n${url}`),
        ...ledger('gh pr comment 437 --body hi', `${url}#issuecomment-1`),
        ...ledger('gh pr merge 316 --merge', '✓ Merged pull request o/r#316 (title)'),
        ...ledger('gh pr view 9 --json url', 'https://github.com/o/r/pull/9'),
        ...ledger('gh pr edit 10 --title t', 'https://github.com/o/r/pull/10'),
      ],
    }));
    expect(out.prs).toEqual([
      { url, action: 'create' },
      { url: 'https://github.com/o/r/pull/316', action: 'merge' },
      { url: 'https://github.com/o/r/pull/9', action: 'unknown' },
      { url: 'https://github.com/o/r/pull/10', action: 'update' },
    ]);
  });

  it('files from write_file/edit_file/patch_apply (changes_paths and changes), absolute + deduped', () => {
    const out = computeOutcomes(base({
      toolEvents: [
        ev('write_file', { file_path: '/abs/a.ts' }),
        ev('edit_file', { file_path: 'rel/b.ts' }),
        ev('edit_file', { file_path: '/abs/a.ts' }),
        ev('patch_apply', { changes_paths: ['/abs/c.ts'] }),
        ev('patch_apply', { changes: [{ path: '/abs/d.ts' }] }),
        ev('patch_apply', { dry_run: true, changes_paths: ['/abs/dry.ts'] }),
        ev('write_file', { file_path: '/abs/err.ts' }, { isError: true }),
        ev('read_file', { file_path: '/abs/read.ts' }),
      ],
    }));
    expect(out.filesChanged).toEqual(['/abs/a.ts', `${CWD}/rel/b.ts`, '/abs/c.ts', '/abs/d.ts']);
  });

  it('schedules from schedule tool events (id from result, else args)', () => {
    const out = computeOutcomes(base({
      toolEvents: [
        ev('create_schedule', { name: 'Nightly' }, { result: JSON.stringify({ id: 'nightly', enabled: true }) }),
        ev('update_schedule', { taskId: 'annual' }, { result: 'not json' }),
        ev('cancel_schedule', { taskId: 'old' }, { result: JSON.stringify({ ok: true, taskId: 'old' }) }),
        ev('cancel_schedule', { taskId: 'ghost' }, { result: JSON.stringify({ error: 'task not found' }) }),
      ],
    }));
    expect(out.schedules).toEqual([
      { id: 'nightly', action: 'create' },
      { id: 'annual', action: 'update' },
      { id: 'old', action: 'cancel' },
    ]);
  });

  it('services from afk service ledger commands', () => {
    const out = computeOutcomes(base({
      ledgerEntries: [
        ...ledger('afk service install telegram && afk service start daemon', 'ok'),
        ...ledger('afk service uninstall telegram', 'ok'),
      ],
    }));
    expect(out.services).toEqual([
      { name: 'telegram', action: 'install' },
      { name: 'daemon', action: 'start' },
      { name: 'telegram', action: 'uninstall' },
    ]);
  });

  it.each([
    ['text\n\n**Done**\n- What was done: x', 'done'],
    ['text\n\n## Blocked\n- What blocks: y', 'blocked'],
    ['**Asking**\nWhich one?', 'asking'],
    ['interrupted.', 'interrupted'],
    ['I am done with that, thanks.', null],
  ])('terminalState from %j', (msg, expected) => {
    expect(computeOutcomes(base({ lastAssistantMessage: msg })).terminalState).toBe(expected);
  });

  it('caps commits 200, prs 50, files 500 with filesChangedTruncated', () => {
    const gitLog = Array.from({ length: 250 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0'), subject: `c${i}`, repo: CWD }));
    const prLines = Array.from({ length: 60 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`).join('\n');
    const toolEvents = Array.from({ length: 510 }, (_, i) => ev('write_file', { file_path: `/f/${i}.ts` }));
    const out = computeOutcomes(base({ gitLog, ledgerEntries: ledger('gh pr list', prLines), toolEvents }));
    expect(out.commits).toHaveLength(200);
    expect(out.prs).toHaveLength(50);
    expect(out.filesChanged).toHaveLength(500);
    expect(out.filesChangedTruncated).toBe(true);
    expect(() => OutcomesV1Schema.parse(out)).not.toThrow();
  });

  it('tolerates malformed ledger rows and tool events', () => {
    const out = computeOutcomes(base({
      ledgerEntries: [
        null, 42, 'garbage', {}, { id: 'x', status: 'executed' },
        { id: 'y', status: 'executed', args: 'not-an-object', result: 'x' },
        { id: 'z', status: 'executed', args: { command: 7 } },
        { id: 'w', status: 'executed', args: { command: 'git commit -m x' }, result: { stdout: '[main 3333333] obj result' } },
      ],
      toolEvents: [{ toolName: 'write_file', inputRaw: '{bad json' }, { toolName: 'patch_apply' }],
    }));
    expect(out.commits).toEqual([{ sha: '3333333', repo: CWD, subject: 'obj result', source: 'effect_ledger' }]);
    expect(out.filesChanged).toEqual([]);
    expect(() => OutcomesV1Schema.parse(out)).not.toThrow();
  });
});
