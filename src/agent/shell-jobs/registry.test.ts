import { describe, it, expect } from 'vitest';
import { ShellJobRegistry, type ShellJob } from './registry.js';

/**
 * Wait for the registry to emit `complete` for a specific job id. Must be
 * called BEFORE awaiting the underlying handle promise — the registry's
 * own `.then()` handler runs synchronously after the handle resolves, so
 * a listener attached only after `await handle.promise` would miss the
 * already-fired event. The REPL's wiring attaches its `complete` listener
 * once at registry construction time and never hits this race.
 */
function nextComplete(reg: ShellJobRegistry, id: string): Promise<ShellJob> {
  return new Promise((resolve) => {
    const onComplete = (job: ShellJob): void => {
      if (job.id !== id) return;
      reg.off('complete', onComplete);
      resolve(job);
    };
    reg.on('complete', onComplete);
  });
}

describe('ShellJobRegistry', () => {
  it('assigns sequential ids prefixed with sh-', () => {
    const reg = new ShellJobRegistry();
    const a = reg.start({ command: 'true', mode: 'foreground' });
    const b = reg.start({ command: 'true', mode: 'foreground' });
    expect(a.job.id).toBe('sh-1');
    expect(b.job.id).toBe('sh-2');
  });

  it('emits complete with status=completed on successful exit', async () => {
    const reg = new ShellJobRegistry();
    const { job, handle } = reg.start({ command: 'echo ok', mode: 'foreground' });
    const completed = nextComplete(reg, job.id);
    await handle.promise;
    await completed;
    expect(job.status).toBe('completed');
    expect(job.result?.exitCode).toBe(0);
  });

  it('emits complete with status=failed on nonzero exit', async () => {
    const reg = new ShellJobRegistry();
    const { job, handle } = reg.start({ command: 'exit 3', mode: 'foreground' });
    const completed = nextComplete(reg, job.id);
    await handle.promise;
    await completed;
    expect(job.status).toBe('failed');
    expect(job.result?.errorReason).toBe('nonzero-exit');
  });

  it('list() returns jobs in start order', () => {
    const reg = new ShellJobRegistry();
    const a = reg.start({ command: 'true', mode: 'foreground' });
    const b = reg.start({ command: 'true', mode: 'foreground' });
    const list = reg.list();
    expect(list[0]?.id).toBe(a.job.id);
    expect(list[1]?.id).toBe(b.job.id);
  });

  it('running() excludes completed jobs', async () => {
    const reg = new ShellJobRegistry();
    const { job, handle } = reg.start({ command: 'true', mode: 'foreground' });
    const completed = nextComplete(reg, job.id);
    await handle.promise;
    await completed;
    expect(reg.running()).toHaveLength(0);
  });

  it('kill() terminates a running job and marks it killed', async () => {
    const reg = new ShellJobRegistry();
    const { job, handle } = reg.start({ command: 'sleep 5', mode: 'background' });
    expect(job.status).toBe('running');
    const completed = nextComplete(reg, job.id);
    // Kill synchronously and assert in the test body. A detached
    // `setTimeout(() => expect(...))` would swallow the assertion if it threw
    // and races spawn timing on a loaded CI runner. The job is 'running' and
    // its AbortController is registered synchronously by start(), so kill()
    // is deterministic here. (PR #565 review.)
    expect(reg.kill(job.id)).toBe(true);
    await handle.promise;
    await completed;
    expect(job.status).toBe('killed');
    expect(job.result?.errorReason).toBe('abort');
  });

  it('kill() of unknown id returns false', () => {
    const reg = new ShellJobRegistry();
    expect(reg.kill('sh-9999')).toBe(false);
  });

  it('killAll() kills every running job and returns the snapshot', async () => {
    const reg = new ShellJobRegistry();
    const a = reg.start({ command: 'sleep 5', mode: 'background' });
    const b = reg.start({ command: 'sleep 5', mode: 'background' });
    const completedA = nextComplete(reg, a.job.id);
    const completedB = nextComplete(reg, b.job.id);
    const snapshot = reg.killAll();
    expect(snapshot.map((j) => j.id).sort()).toEqual([a.job.id, b.job.id].sort());
    await Promise.all([a.handle.promise, b.handle.promise, completedA, completedB]);
    expect(reg.runningCount()).toBe(0);
  });

  it('runningCount() reflects in-flight jobs', async () => {
    const reg = new ShellJobRegistry();
    expect(reg.runningCount()).toBe(0);
    const { job, handle } = reg.start({ command: 'echo done', mode: 'foreground' });
    expect(reg.runningCount()).toBe(1);
    const completed = nextComplete(reg, job.id);
    await handle.promise;
    await completed;
    expect(reg.runningCount()).toBe(0);
  });

  it('a throwing complete listener does not break the registry', async () => {
    const reg = new ShellJobRegistry();
    reg.on('complete', () => {
      throw new Error('listener boom');
    });
    const { handle } = reg.start({ command: 'echo ok', mode: 'foreground' });
    // Should not reject; the registry must swallow listener throws.
    const result = await handle.promise;
    expect(result.exitCode).toBe(0);
  });
});
