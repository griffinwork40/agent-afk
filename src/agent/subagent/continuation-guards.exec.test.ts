/**
 * Default checkpoint git runner: a git that ignores the timeout kill (or whose
 * stdio never closes) is abandoned at the hard bound and SIGKILLed; the
 * capture resolves `unavailable` instead of hanging (docs/subagent-continuation.md, D5).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ kills: [] as unknown[], opts: [] as Record<string, unknown>[] }));
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  return {
    ...real,
    // Never invokes the callback: models a git that never exits.
    execFile: ((_file: string, _args: string[], opts: Record<string, unknown>) => {
      spawned.opts.push(opts);
      const child = new EventEmitter() as EventEmitter & { kill: (s?: unknown) => boolean };
      child.kill = (s?: unknown) => { spawned.kills.push(s); return true; };
      return child;
    }) as unknown as typeof real.execFile,
  };
});

import { captureWorkspaceCheckpoint, CHECKPOINT_GIT_KILL_GRACE_MS, CHECKPOINT_GIT_TIMEOUT_MS } from './continuation-guards.js';

describe('checkpoint git runner hard bound', () => {
  it('a git that never exits is SIGKILLed and the checkpoint resolves unavailable', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const p = captureWorkspaceCheckpoint('/repo').then((c) => { done = true; return c; });
      await vi.advanceTimersByTimeAsync(CHECKPOINT_GIT_TIMEOUT_MS);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(CHECKPOINT_GIT_KILL_GRACE_MS + 1);
      expect(await p).toEqual({ cwd: '/repo', git: true, unavailable: true });
      expect(spawned.kills).toEqual(['SIGKILL']);
      expect(spawned.opts[0]).toMatchObject({ timeout: CHECKPOINT_GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    } finally {
      vi.useRealTimers();
    }
  });
});
