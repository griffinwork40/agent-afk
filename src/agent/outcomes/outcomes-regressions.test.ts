/** PR4540: production evidence -> outcomes -> persisted artifacts -> delayed probes. */
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>() }));
import { rmSyncRetry } from '../../__test-utils__/rm-sync-retry.js';
import { classifyToolCall } from '../effect-ledger/classifier.js';
import { EffectStore } from '../effect-ledger/store.js';
import { getEffectLedgerPath, getSessionJournalPath } from '../../paths.js';
import { computeOutcomes } from './compute-outcomes.js';
import { artifactsFromOutcomes } from './session-end-hook.js';
import { processRecord, type RelabelDeps } from './relabel-job.js';
import { readRecord, upsertVotes } from './store.js';
import { getSessionOutcomes, _resetSessionOutcomesCache } from './session-outcomes.js';
import { boundedLines, readOutcomesJournal } from './outcomes-input.js';

const home = mkdtempSync(join(tmpdir(), 'afk-outcomes-regressions-'));
const savedHome = process.env['AFK_HOME'];
const savedState = process.env['AFK_STATE_DIR'];
process.env['AFK_HOME'] = home;
delete process.env['AFK_STATE_DIR'];
const repo = join(home, 'root');
const other = join(home, 'other repo');
const outcomesDir = join(home, 'outcomes');
const budget = () => ({ signal: new AbortController().signal, deadline: Date.now() + 5000 });
const now = new Date('2026-10-30T12:00:00Z');

beforeAll(() => {
  mkdirSync(repo);
  mkdirSync(other);
  execFileSync('git', ['init', '-q', repo]);
});
afterEach(() => { _resetSessionOutcomesCache(); vi.restoreAllMocks(); });
afterAll(() => {
  if (savedHome === undefined) delete process.env['AFK_HOME']; else process.env['AFK_HOME'] = savedHome;
  if (savedState === undefined) delete process.env['AFK_STATE_DIR']; else process.env['AFK_STATE_DIR'] = savedState;
  rmSyncRetry(home);
});

function journal(id: string, command: string, result: string, isError = false): void {
  const path = getSessionJournalPath(id);
  mkdirSync(join(path, '..'), { recursive: true });
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'bash', input: { command } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call', isError, content: [{ type: 'text', text: result }] }] },
    { role: 'assistant', content: [{ type: 'text', text: '## Done\nDelivered.' }] },
  ];
  writeFileSync(path, messages.map((message, index) => JSON.stringify({ v: 1, ts: index, kind: 'append', index, message })).join('\n'));
}

function persist(id: string, outcomes: ReturnType<typeof computeOutcomes>): void {
  upsertVotes(id, [], {
    schema_version: 1, session_id: id, label: 'unknown', confidence: 0,
    state: 'provisional', settles_after: '2026-10-01T00:00:00Z', session_kind: 'mutating', self_report: 'done',
    artifacts: artifactsFromOutcomes(outcomes), outcomes,
  }, { outcomesDir });
}

function deps(): RelabelDeps {
  return { now: () => now, checkAncestor: vi.fn(async () => true), checkRevert: vi.fn(async () => false),
    fetchPrState: vi.fn(async () => ({ state: 'MERGED' as const, mergedAt: now.toISOString() })),
    execFnCi: vi.fn(async () => ({ stdout: '[]', stderr: '' })),
    execFnFof: vi.fn(async () => ({ stdout: '[]', stderr: '' })) };
}

describe('PR4540 production regressions', () => {
  it.each(['cd', 'git-C'])('retains standalone cross-repo commit and probes its repo (%s)', async (style) => {
    const id = `cross-${style}`;
    const command = style === 'cd' ? `cd "${other}" && git commit -m fix` : `git -C "${other}" commit -m fix`;
    expect(classifyToolCall('bash', { command }).isExternal).toBe(false);
    journal(id, command, '[main abc1234] fix');
    const outcomes = await getSessionOutcomes(id, { cwd: repo });
    expect(outcomes?.commits).toEqual([{ sha: 'abc1234', repo: other, subject: 'fix', source: 'tool_result' }]);
    persist(id, outcomes!);
    expect(readRecord(id, outcomesDir)?.artifacts.commitRepos).toEqual({ abc1234: other });
    const d = deps();
    await processRecord(id, d, false, outcomesDir);
    expect(d.checkAncestor).toHaveBeenCalledWith('abc1234', other);
    expect(d.checkRevert).toHaveBeenCalledWith('abc1234', other);
  });

  it('does not attribute failed commit output', async () => {
    journal('failed-commit', `cd "${other}" && git commit -m fix`, '[main abc1234] fix', true);
    expect((await getSessionOutcomes('failed-commit', { cwd: repo }))?.commits).toEqual([]);
  });

  it('does not score an updated or merged PR as this session creating it', async () => {
    const store = new EffectStore(getEffectLedgerPath());
    for (const action of ['edit', 'merge']) {
      const row = store.writePending({ idempotencyKey: action, operationType: 'bash_external', sessionId: 'pr-update',
        args: { command: `gh pr ${action} 7` } });
      await store.updateStatus({ id: row.id, status: 'executed', result: 'https://github.com/o/r/pull/7' });
    }
    const outcomes = await getSessionOutcomes('pr-update', { cwd: repo });
    expect(outcomes?.prs).toHaveLength(1);
    persist('pr-update', outcomes!);
    expect(readRecord('pr-update', outcomesDir)?.artifacts.prs).toEqual([]);
    const d = deps();
    await processRecord('pr-update', d, false, outcomesDir);
    expect(d.fetchPrState).not.toHaveBeenCalled();
    expect(d.execFnCi).not.toHaveBeenCalled();
  });

  it.each(['install', 'uninstall', 'start', 'stop', 'restart'])('classifies and extracts successful service %s', async (action) => {
    const id = `svc-${action}`;
    const args = { command: `afk service ${action} daemon` };
    const classification = classifyToolCall('bash', args);
    expect(classification.isExternal).toBe(true);
    const store = new EffectStore(getEffectLedgerPath());
    const pending = store.writePending({ idempotencyKey: id, operationType: classification.operationType, sessionId: id, args });
    await store.updateStatus({ id: pending.id, status: 'executed', result: 'ok' });
    expect((await getSessionOutcomes(id, { cwd: repo }))?.services).toEqual([{ name: 'daemon', action }]);
  });

  it('excludes failed service operations and read-only status', async () => {
    expect(classifyToolCall('bash', { command: 'afk service status daemon' }).isExternal).toBe(false);
    const store = new EffectStore(getEffectLedgerPath());
    const pending = store.writePending({ idempotencyKey: 'svc-failed', operationType: 'bash_external', sessionId: 'svc-failed',
      args: { command: 'afk service install daemon' } });
    await store.updateStatus({ id: pending.id, status: 'failed', result: 'failed' });
    expect((await getSessionOutcomes('svc-failed', { cwd: repo }))?.services).toEqual([]);
  });

  it('reads journal once and folds final assistant text without hydrating unrelated blobs', async () => {
    journal('one-pass', 'echo ok', 'ok');
    const spy = vi.spyOn(fs, 'createReadStream');
    const result = await getSessionOutcomes('one-pass', { cwd: repo });
    expect(result?.terminalState).toBe('done');
    expect(spy.mock.calls.filter(([p]) => p === getSessionJournalPath('one-pass'))).toHaveLength(1);
  });

  it('aborts slow streaming input at the total deadline rather than silently succeeding', async () => {
    journal('slow-input', 'echo ok', 'ok');
    const real = fs.createReadStream;
    let slow: Readable | undefined;
    vi.spyOn(fs, 'createReadStream').mockImplementation(((path, options) => {
      if (path !== getSessionJournalPath('slow-input')) return real(path, options);
      slow = new Readable({ read() {}, signal: (options as { signal: AbortSignal }).signal });
      return slow;
    }) as typeof fs.createReadStream);
    const start = Date.now();
    expect(await getSessionOutcomes('slow-input', { cwd: repo }, { timeoutMs: 100 })).toBeNull();
    expect(Date.now() - start).toBeLessThan(1500);
    expect(slow?.destroyed).toBe(true);
  });

  it('rejects a large journal record instead of parsing unbounded input or returning partial outcomes', async () => {
    const path = getSessionJournalPath('large-input');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'x'.repeat(1024 * 1024));
    await expect(readOutcomesJournal('large-input', budget())).rejects.toThrow('line limit');
    expect(await getSessionOutcomes('large-input', { cwd: repo })).toBeNull();
  });

  it('checks deadline during cached large-file processing', async () => {
    const path = join(home, 'large.jsonl');
    writeFileSync(path, '{}\n'.repeat(200_000));
    const b = budget();
    let count = 0;
    await expect((async () => {
      for await (const _line of boundedLines(path, b)) {
        count++;
        if (count === 10) b.deadline = 0;
      }
    })()).rejects.toThrow('deadline');
    expect(count).toBeLessThan(200_000);
  });
});
