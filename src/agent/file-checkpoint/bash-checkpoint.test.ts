import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { beginBashCheckpoint } from './bash-checkpoint.js';
import { createFileCheckpointRegistry } from './file-checkpoint.js';
import { captureWorkspaceTree, diffTrees } from './git-snapshot.js';
import { readTurnLog } from './turn-log.js';
import { createBashHandler } from '../tools/handlers/bash.js';
import { spawnBashProcess } from '../tools/handlers/bash.spawn.js';
import { DetachableToolRegistry } from '../tools/detach-registry.js';

vi.mock('./git-snapshot.js', () => ({ captureWorkspaceTree: vi.fn(), diffTrees: vi.fn() }));
vi.mock('../tools/handlers/bash.spawn.js', () => ({ spawnBashProcess: vi.fn() }));
vi.mock('../tools/handlers/bash-kill.js', () => ({ killBashProcess: vi.fn() }));

let root: string;
let registry: ReturnType<typeof createFileCheckpointRegistry>;
let proc: ChildProcess;
beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), 'afk-bash-checkpoint-'));
  registry = createFileCheckpointRegistry('session', 'turn', root);
  vi.mocked(captureWorkspaceTree).mockResolvedValue({ ok: true, repoRoot: root, tree: 'tree' });
  vi.mocked(diffTrees).mockResolvedValue({ ok: true, changes: [{ absPath: join(root, 'file'), prior: null }], skipped: [], truncated: false });
  proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined }) as unknown as ChildProcess;
  vi.mocked(spawnBashProcess).mockReturnValue(proc);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
const outcome = () => readTurnLog('session', root).filter((entry) => entry.kind === 'bash');
async function runClose(code: number) {
  vi.mocked(spawnBashProcess).mockImplementation(() => { setTimeout(() => proc.emit('close', code), 0); return proc; });
  return createBashHandler('default', root)({ command: 'fake' }, new AbortController().signal, { fileCheckpoint: registry });
}

describe('bash checkpoint hook', () => {
  it('captures and publishes prior states before returning', async () => {
    await runClose(0);
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(2);
    expect(registry.touchedPaths()).toEqual([join(root, 'file')]);
    expect(outcome()).toEqual([expect.objectContaining({ status: 'captured', files: 1 })]);
  });
  it('captures even when the command exits nonzero', async () => {
    const result = await runClose(7);
    expect(result.isError).toBe(true);
    expect(outcome()).toEqual([expect.objectContaining({ status: 'captured' })]);
  });
  it('records not-git and still executes bash', async () => {
    vi.mocked(captureWorkspaceTree).mockResolvedValue({ ok: false, reason: 'not-git' });
    await runClose(0);
    expect(spawnBashProcess).toHaveBeenCalledOnce();
    expect(diffTrees).not.toHaveBeenCalled();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'not-git' })]);
  });
  it('reports disabled capture without calling git', async () => {
    vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_DISABLE', '1');
    await runClose(0);
    expect(captureWorkspaceTree).not.toHaveBeenCalled();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'disabled' })]);
  });
  it('snapshot exceptions never fail the command', async () => {
    vi.mocked(captureWorkspaceTree).mockRejectedValue(new Error('disk failure'));
    const result = await runClose(0);
    expect(result.isError).not.toBe(true);
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'error' })]);
  });
  it('publication failure reports partial and never fails bash', async () => {
    vi.spyOn(registry, 'recordPriorState').mockRejectedValue(new Error('disk full'));
    const result = await runClose(0);
    expect(result.isError).not.toBe(true);
    expect(outcome()).toEqual([expect.objectContaining({ status: 'partial', reason: 'error', files: 0 })]);
  });
  it('bounds a hung final capture', async () => {
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    const hook = await beginBashCheckpoint(registry, root);
    vi.mocked(captureWorkspaceTree).mockImplementation(() => new Promise(() => {}));
    const finish = hook.finish();
    await vi.advanceTimersByTimeAsync(11); await finish;
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'timeout' })]);
  });
  it('bounds a hung initial capture', async () => {
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    vi.mocked(captureWorkspaceTree).mockImplementation(() => new Promise(() => {}));
    const start = beginBashCheckpoint(registry, root);
    await vi.advanceTimersByTimeAsync(11);
    await (await start).finish();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'timeout' })]);
  });
  it('bounds a hung diff and records an outcome', async () => {
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    vi.mocked(diffTrees).mockImplementation(() => new Promise(() => {}));
    const hook = await beginBashCheckpoint(registry, root);
    const finish = hook.finish();
    await vi.advanceTimersByTimeAsync(11); await finish;
    expect(outcome()).toEqual([expect.objectContaining({ status: 'partial', reason: 'timeout' })]);
  });
  it.each(['truncated', 'symlink'] as const)('reports %s as partial', async (reason) => {
    vi.mocked(diffTrees).mockResolvedValue({ ok: true, changes: [], truncated: reason === 'truncated', skipped: reason === 'symlink' ? [{ absPath: join(root, 'link'), reason: 'symlink' }] : [] });
    await runClose(0);
    expect(outcome()).toEqual([expect.objectContaining({ status: 'partial', reason: expect.stringContaining(reason) })]);
  });
  it('does not capture explicit background calls', async () => {
    await createBashHandler('default', root)({ command: 'fake', run_in_background: true }, new AbortController().signal, { fileCheckpoint: registry });
    expect(captureWorkspaceTree).not.toHaveBeenCalled();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'run_in_background' })]);
  });
  it('does not call git without a registry', async () => {
    vi.mocked(spawnBashProcess).mockImplementation(() => { setTimeout(() => proc.emit('close', 0), 0); return proc; });
    await createBashHandler('default', root)({ command: 'fake' }, new AbortController().signal);
    expect(captureWorkspaceTree).not.toHaveBeenCalled();
  });
  it('captures after timeout kill', async () => {
    const result = await createBashHandler('default', root)({ command: 'fake', timeout_ms: 5 }, new AbortController().signal, { fileCheckpoint: registry });
    expect(result.isError).toBe(true);
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(2);
    expect(outcome()).toHaveLength(1);
  });
  it('still captures a command aborted mid-run (it may already have changed files)', async () => {
    const controller = new AbortController();
    vi.mocked(spawnBashProcess).mockImplementation(() => { setTimeout(() => controller.abort(), 0); return proc; });
    await createBashHandler('default', root)({ command: 'fake' }, controller.signal, { fileCheckpoint: registry });
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(2);
    expect(outcome()).toHaveLength(1);
    expect(outcome()[0]).not.toMatchObject({ status: 'skipped' });
  });
  it('disables later snapshots for an index after a capture timeout', async () => {
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    vi.mocked(captureWorkspaceTree).mockImplementation(() => new Promise(() => {}));
    const first = beginBashCheckpoint(registry, root);
    await vi.advanceTimersByTimeAsync(11);
    await (await first).finish();
    await (await beginBashCheckpoint(registry, root)).finish();
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(1);
    expect(outcome()).toEqual([
      expect.objectContaining({ status: 'skipped', reason: 'timeout' }),
      expect.objectContaining({ status: 'skipped', reason: 'timeout (capture disabled for this session after a slow first snapshot)' }),
    ]);
  });
  it('logs abort during the before snapshot without spawning or taking an after snapshot', async () => {
    const controller = new AbortController();
    vi.mocked(captureWorkspaceTree).mockImplementation(async () => {
      controller.abort();
      return { ok: true, repoRoot: root, tree: 'before' };
    });
    await createBashHandler('default', root)({ command: 'fake' }, controller.signal, { fileCheckpoint: registry });
    expect(spawnBashProcess).not.toHaveBeenCalled();
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(1);
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'aborted before spawn' })]);
  });
  it('bounds abort during a hung before snapshot to one timeout without more git work', async () => {
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    const controller = new AbortController();
    vi.mocked(captureWorkspaceTree).mockImplementation(() => new Promise(() => {}));
    const run = createBashHandler('default', root)({ command: 'fake' }, controller.signal, { fileCheckpoint: registry });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    await run;
    expect(spawnBashProcess).not.toHaveBeenCalled();
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(1);
    expect(diffTrees).not.toHaveBeenCalled();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'aborted before spawn' })]);
  });
  it('still diffs when abort fires during the after snapshot (the command already ran)', async () => {
    const controller = new AbortController();
    const hook = await beginBashCheckpoint(registry, root, undefined, controller.signal);
    vi.mocked(captureWorkspaceTree).mockImplementation(async () => {
      controller.abort();
      return { ok: true, repoRoot: root, tree: 'after' };
    });
    await hook.finish();
    expect(diffTrees).toHaveBeenCalledTimes(1);
  });
  it('waits for in-flight publication and stops before publishing the next file after the deadline', async () => {
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    vi.mocked(diffTrees).mockResolvedValue({ ok: true, changes: [
      { absPath: join(root, 'one'), prior: null }, { absPath: join(root, 'two'), prior: null },
    ], skipped: [], truncated: false });
    let release!: () => void;
    const publish = vi.spyOn(registry, 'recordPriorState').mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const hook = await beginBashCheckpoint(registry, root);
    let finished = false;
    const finish = hook.finish().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(11);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    release();
    await finish;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(outcome()).toEqual([expect.objectContaining({ status: 'partial', reason: 'timeout', files: 1 })]);
  });
  it('finish uses a single shared deadline: after-capture receives remaining time, not a fresh budget', async () => {
    // Regression for PR4298 item 1: the old code computed deadline = Date.now() + timeoutMs
    // inside finish() AFTER after-capture had already run, granting publication a fresh full
    // budget instead of the time remaining from the shared deadline.
    //
    // With the fix, after-capture receives `remaining()` time. When the fake clock advances
    // past the timeout DURING after-capture, `bounded()` rejects with 'timeout', so
    // `capture()` returns { ok:false, reason:'timeout' } → finish logs 'skipped'.
    // diffTrees must NOT be called — there is nothing left to diff.
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    const hook = await beginBashCheckpoint(registry, root);
    vi.mocked(captureWorkspaceTree).mockImplementation(async () => {
      // Consume the entire budget during the after-capture phase.
      await vi.advanceTimersByTimeAsync(11);
      return { ok: true, repoRoot: root, tree: 'after' };
    });
    vi.mocked(diffTrees).mockImplementation(() => new Promise(() => {})); // should never be reached
    const finish = hook.finish();
    await vi.runAllTimersAsync();
    await finish;
    // After-capture times out → capture returns { ok:false, reason:'timeout' } → skipped.
    // diffTrees must not have been called (budget was exhausted).
    expect(diffTrees).not.toHaveBeenCalled();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'timeout' })]);
  });

  it('after-capture timeout does not grant publication a fresh full budget', async () => {
    // Regression for PR4298 item 1: after-capture timing out must propagate a zero/negative
    // remaining time to publication, not restart the clock. Because after-capture times out,
    // capture() returns { ok: false, reason: 'timeout' }, so publication never runs → skipped.
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    const hook = await beginBashCheckpoint(registry, root);
    vi.mocked(captureWorkspaceTree).mockImplementation(() => new Promise(() => {})); // hung after-capture
    const finish = hook.finish();
    await vi.advanceTimersByTimeAsync(11);
    await finish;
    expect(diffTrees).not.toHaveBeenCalled();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'timeout' })]);
  });

  it.each(['before', 'after'])('passes through partial snapshot reasons from %s capture', async (phase) => {
    const complete = { ok: true as const, repoRoot: root, tree: 'tree' };
    const partial = { ...complete, partial: 'unreadable paths omitted' };
    vi.mocked(captureWorkspaceTree).mockResolvedValueOnce(phase === 'before' ? partial : complete)
      .mockResolvedValueOnce(phase === 'after' ? partial : complete);
    await runClose(0);
    expect(outcome()).toEqual([expect.objectContaining({ status: 'partial', reason: partial.partial })]);
  });
  it('skips after-snapshot diff when repoRoot changes between captures', async () => {
    // Finding #5: verify the "repository changed" skip path when repoRoot
    // differs between the before and after captures.
    const otherRoot = join(root, 'other');
    vi.mocked(captureWorkspaceTree)
      .mockResolvedValueOnce({ ok: true, repoRoot: root, tree: 'before' })
      .mockResolvedValueOnce({ ok: true, repoRoot: otherRoot, tree: 'after' });
    await runClose(0);
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(2);
    expect(diffTrees).not.toHaveBeenCalled();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'repository changed' })]);
  });

  it('timedOutIndexes persists across different registry instances for the same index file', async () => {
    // Finding #6: timedOutIndexes is module-level state keyed by indexFile path.
    // A timeout recorded against one registry must disable capture for a second
    // registry that shares the same session (and therefore the same indexFile).
    vi.useFakeTimers(); vi.stubEnv('AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS', '10');
    // First registry: trigger a capture timeout so the index is added to timedOutIndexes.
    vi.mocked(captureWorkspaceTree).mockImplementation(() => new Promise(() => {}));
    const first = beginBashCheckpoint(registry, root);
    await vi.advanceTimersByTimeAsync(11);
    await (await first).finish();
    expect(outcome()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'timeout' })]);

    // Second registry: different object instance, same sessionId/stateDir → same indexFile path.
    const registry2 = createFileCheckpointRegistry('session', 'turn2', root);
    vi.mocked(captureWorkspaceTree).mockResolvedValue({ ok: true, repoRoot: root, tree: 'tree' });
    await (await beginBashCheckpoint(registry2, root)).finish();

    // captureWorkspaceTree must NOT be called again: the index is disabled.
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(1);
    // Both turns' log entries are in the same session log file.
    const allBash = readTurnLog('session', root).filter((e) => e.kind === 'bash');
    expect(allBash).toEqual([
      expect.objectContaining({ status: 'skipped', reason: 'timeout' }),
      expect.objectContaining({ status: 'skipped', reason: 'timeout (capture disabled for this session after a slow first snapshot)' }),
    ]);
  });

  it('captures once at detach and records partial, not at later close', async () => {
    const detachRegistry = new DetachableToolRegistry();
    const run = createBashHandler('default', root)({ command: 'fake' }, new AbortController().signal, { fileCheckpoint: registry, detachRegistry, toolUseId: 'tool' });
    await vi.waitFor(() => expect(spawnBashProcess).toHaveBeenCalledOnce());
    detachRegistry.detachAll();
    await run;
    expect(outcome()).toEqual([expect.objectContaining({ status: 'partial', reason: expect.stringContaining('detached') })]);
    proc.emit('close', 0);
    expect(captureWorkspaceTree).toHaveBeenCalledTimes(2);
    expect(outcome()).toHaveLength(1);
  });
});
