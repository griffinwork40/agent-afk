/**
 * Cross-turn rewind (#4271): fold across later turns, all-or-report restore,
 * drift guard, restore log entries, and the rewind lock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginCheckpointTurn, endCheckpointTurn } from './turn-lifecycle.js';
import { rewindFiles } from './rewind-files.js';
import { readTurnLog, turnsFrom, expectedHashes, hashBytes, appendTurnLog } from './turn-log.js';

let tmp: string;
let stateDir: string;
const SESSION = 'cross-session';

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'afk-cross-turn-'));
  stateDir = path.join(tmp, 'state');
  mkdirSync(stateDir, { recursive: true });
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const deps = () => ({ sessionId: SESSION, enableFileCheckpointing: true, _stateDir: stateDir });
const file = (name: string) => path.join(tmp, name);
const read = (name: string) => readFileSync(file(name), 'utf8');

/** Simulate one checkpointed agent turn that writes `writes` (name → content). */
async function turn(turnId: string, writes: Record<string, string>): Promise<void> {
  const registry = beginCheckpointTurn(SESSION, turnId, stateDir);
  for (const [name, content] of Object.entries(writes)) {
    await registry.snapshotFile(file(name));
    writeFileSync(file(name), content);
  }
  endCheckpointTurn(SESSION, registry, stateDir);
  endCheckpointTurn(SESSION, registry, stateDir); // idempotent: second call writes nothing
}

describe('turn log', () => {
  it('records turn starts in order, one post entry per touching turn, and skips torn lines', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    await turn('t2', {});
    const logPath = path.join(stateDir, 'file-checkpoints', SESSION, 'turns.jsonl');
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}{"kind":"turn","tu`);
    const log = readTurnLog(SESSION, stateDir);
    expect(log.map((e) => e.kind)).toEqual(['turn', 'post', 'turn']);
    expect(turnsFrom(log, 't1')).toEqual(['t1', 't2']);
    expect(turnsFrom(log, 'never')).toBeUndefined();
    expect(expectedHashes(log).get(file('a'))).toBe(hashBytes(Buffer.from('v1')));
  });
});

describe('cross-turn rewind', () => {
  it('rewinding to an earlier turn undoes later turns too (earliest snapshot wins)', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    await turn('t2', { a: 'v2', b: 'created' });
    const result = await rewindFiles(deps(), 't1');
    expect(result.canRewind).toBe(true);
    expect(read('a')).toBe('v0');
    expect(existsSync(file('b'))).toBe(false);
    expect(new Set(result.filesChanged)).toEqual(new Set([file('a'), file('b')]));
  });

  it('rewinding to the later turn restores only its own starting state', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    await turn('t2', { a: 'v2', b: 'created' });
    expect((await rewindFiles(deps(), 't2')).canRewind).toBe(true);
    expect(read('a')).toBe('v1');
    expect(existsSync(file('b'))).toBe(false);
  });

  it('acceptance shape: two edits plus a created file are previewed, then restored and deleted', async () => {
    writeFileSync(file('one'), 'one-0');
    writeFileSync(file('two'), 'two-0');
    await turn('t1', { one: 'one-1', two: 'two-1', three: 'new' });
    const preview = await rewindFiles(deps(), 't1', { dryRun: true });
    expect(new Set(preview.filesChanged)).toEqual(new Set([file('one'), file('two'), file('three')]));
    expect(read('one')).toBe('one-1');
    const result = await rewindFiles(deps(), 't1');
    expect(result).toMatchObject({ canRewind: true, deletions: expect.any(Number) });
    expect(read('one')).toBe('one-0');
    expect(read('two')).toBe('two-0');
    expect(existsSync(file('three'))).toBe(false);
  });

  it('turns that wrote nothing are rewindable no-ops, not missing checkpoints', async () => {
    await turn('quiet', {});
    expect(await rewindFiles(deps(), 'quiet')).toEqual({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 });
  });

  it('a repeat rewind after a restore sees no false conflicts (restore supersedes post hashes)', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    await turn('t2', { a: 'v2' });
    expect((await rewindFiles(deps(), 't2')).canRewind).toBe(true);
    const preview = await rewindFiles(deps(), 't1', { dryRun: true });
    expect(preview.conflicts).toBeUndefined();
    expect(preview.filesChanged).toEqual([file('a')]);
    expect(readTurnLog(SESSION, stateDir).some((e) => e.kind === 'restore')).toBe(true);
  });

  it('a turn missing from the log falls back to single-turn behaviour', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    rmSync(path.join(stateDir, 'file-checkpoints', SESSION, 'turns.jsonl'));
    expect((await rewindFiles(deps(), 't1')).canRewind).toBe(true);
    expect(read('a')).toBe('v0');
  });
});

describe('all-or-report restore', () => {
  it('attempts every path and reports each failure instead of stopping at the first', async () => {
    writeFileSync(file('a'), 'a0');
    await turn('t1', { a: 'a1', made: 'new', c: 'c1' });
    // `made` was created by the turn; replacing it with a directory makes its
    // deletion fail. The other two paths must still be restored.
    rmSync(file('made'));
    mkdirSync(file('made'));
    const result = await rewindFiles(deps(), 't1', { overwriteConflicts: true });
    expect(result.canRewind).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ path: file('made') })]);
    expect(result.error).toMatch(/Rewind failed at/);
    expect(read('a')).toBe('a0');
    expect(existsSync(file('c'))).toBe(false);
    expect(new Set(result.filesChanged)).toEqual(new Set([file('a'), file('c')]));
  });

  it('removes the rewind lock after a live restore', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    await rewindFiles(deps(), 't1');
    expect(existsSync(path.join(stateDir, 'file-checkpoints', SESSION, '.rewind-lock'))).toBe(false);
  });
});

describe('bash log entries', () => {
  it('appendTurnLog writes a bash entry that roundtrips through readTurnLog', () => {
    appendTurnLog(SESSION, { kind: 'bash', turnId: 't1', status: 'captured', files: 3, ts: 1 }, stateDir);
    appendTurnLog(SESSION, { kind: 'bash', turnId: 't2', status: 'skipped', reason: 'background job', ts: 2 }, stateDir);
    appendTurnLog(SESSION, { kind: 'bash', turnId: 't3', status: 'partial', reason: 'detached mid-run', ts: 3 }, stateDir);
    const log = readTurnLog(SESSION, stateDir);
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({ kind: 'bash', turnId: 't1', status: 'captured', files: 3 });
    expect(log[1]).toMatchObject({ kind: 'bash', turnId: 't2', status: 'skipped', reason: 'background job' });
    expect(log[2]).toMatchObject({ kind: 'bash', turnId: 't3', status: 'partial', reason: 'detached mid-run' });
  });

  it('isEntry guard skips bash entries with unknown status', () => {
    // Write a bash entry with an invalid status directly; readTurnLog should skip it.
    const logPath = path.join(stateDir, 'file-checkpoints', SESSION, 'turns.jsonl');
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, '{"kind":"bash","turnId":"t1","status":"unknown","ts":1}\n');
    expect(readTurnLog(SESSION, stateDir)).toHaveLength(0);
  });
});

describe('uncaptured warnings in rewind results', () => {
  it('no warnings when no bash entries exist in the range', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    const result = await rewindFiles(deps(), 't1', { dryRun: true });
    expect(result.uncaptured).toBeUndefined();
  });

  it('warns about ignored and outside files even when all bash entries are captured', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    appendTurnLog(SESSION, { kind: 'bash', turnId: 't1', status: 'captured', files: 2, ts: Date.now() }, stateDir);
    const result = await rewindFiles(deps(), 't1', { dryRun: true });
    expect(result.uncaptured).toEqual([expect.stringContaining('git-ignored files or files outside the repo')]);
  });

  it('emits warnings for skipped bash entries in the folded suffix', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    await turn('t2', {});
    appendTurnLog(SESSION, { kind: 'bash', turnId: 't2', status: 'skipped', reason: 'background job', ts: Date.now() }, stateDir);
    const result = await rewindFiles(deps(), 't1', { dryRun: true });
    expect(result.uncaptured).toBeDefined();
    expect(result.uncaptured!.length).toBeGreaterThanOrEqual(2);
    expect(result.uncaptured!.some((w) => w.includes('background job'))).toBe(true);
    expect(result.uncaptured!.some((w) => w.includes('External side-effects'))).toBe(true);
  });

  it('emits warnings for partial bash entries in the folded suffix', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    appendTurnLog(SESSION, { kind: 'bash', turnId: 't1', status: 'partial', reason: 'detached', ts: Date.now() }, stateDir);
    const result = await rewindFiles(deps(), 't1');
    expect(result.uncaptured).toBeDefined();
    expect(result.uncaptured!.some((w) => w.includes('detached'))).toBe(true);
    expect(result.uncaptured!.some((w) => w.includes('External side-effects'))).toBe(true);
  });

  it('bash entry outside the rewind suffix does not generate warnings', async () => {
    writeFileSync(file('a'), 'v0');
    await turn('t1', { a: 'v1' });
    await turn('t2', { a: 'v2' });
    // t0 is before t1 in real time but NOT in the log suffix when rewinding to t2
    appendTurnLog(SESSION, { kind: 'bash', turnId: 'not-in-log', status: 'skipped', ts: Date.now() }, stateDir);
    const result = await rewindFiles(deps(), 't2', { dryRun: true });
    expect(result.uncaptured).toBeUndefined();
  });

  it('zero-snapshot turn with uncaptured warnings still carries them', async () => {
    await turn('quiet', {});
    appendTurnLog(SESSION, { kind: 'bash', turnId: 'quiet', status: 'skipped', reason: 'BASH_DISABLE', ts: Date.now() }, stateDir);
    const result = await rewindFiles(deps(), 'quiet');
    expect(result.canRewind).toBe(true);
    expect(result.uncaptured).toBeDefined();
    expect(result.uncaptured!.some((w) => w.includes('BASH_DISABLE'))).toBe(true);
  });
});

describe('drift guard', () => {
  it('flags a file changed outside the agent and refuses to overwrite it without consent', async () => {
    writeFileSync(file('a'), 'v0');
    writeFileSync(file('b'), 'b0');
    await turn('t1', { a: 'v1', b: 'b1' });
    writeFileSync(file('a'), 'human edit');

    const preview = await rewindFiles(deps(), 't1', { dryRun: true });
    expect(preview.canRewind).toBe(true);
    expect(preview.conflicts).toEqual([file('a')]);

    const kept = await rewindFiles(deps(), 't1');
    expect(kept.canRewind).toBe(false);
    expect(kept.failures).toEqual([expect.objectContaining({ path: file('a'), error: expect.stringMatching(/outside the agent/) })]);
    expect(read('a')).toBe('human edit');
    expect(read('b')).toBe('b0');

    expect((await rewindFiles(deps(), 't1', { overwriteConflicts: true })).canRewind).toBe(true);
    expect(read('a')).toBe('v0');
  });
});
