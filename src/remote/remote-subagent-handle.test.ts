/**
 * Unit tests for RemoteSubagentHandle.
 *
 * Uses a fake SshRunner (same pattern as remote-run.test.ts) so no real SSH
 * connection is made. Covers the SubagentHandle contract over remote transport:
 * status transitions, success/error/aborted/lost outcomes, cancel, and
 * the no-op stubs (sendMessage, steer, teardown).
 */

import { describe, it, expect, vi } from 'vitest';
import { RemoteSubagentHandle } from './remote-subagent-handle.js';
import { PID_MARKER, EXIT_MARKER } from './remote-script.js';
import type { SshRunner, SshExecResult, SshStreamOptions } from './ssh-runner.js';
import type { RemoteRunDeps } from './remote-run.js';

// ---------------------------------------------------------------------------
// Fake transport helpers (mirrors remote-run.test.ts style)
// ---------------------------------------------------------------------------

const ev = (o: unknown): string => JSON.stringify(o);
const MSG = (content: string): string =>
  ev({ type: 'message', message: { content, timestamp: 't' } });
const DONE = ev({ type: 'done', metadata: { durationMs: 1 } });
const ERR_EV = (msg: string): string =>
  ev({ type: 'error', error: { message: msg } });

type StreamPlan = string[][];

function fakeRunner(opts: { launch?: SshExecResult; streams: StreamPlan; errTail?: string }): SshRunner {
  let streamIdx = 0;
  return {
    async exec(_target: string, script: string, _o: object = {}): Promise<SshExecResult> {
      if (script.includes(PID_MARKER)) {
        return opts.launch ?? { code: 0, stdout: `${PID_MARKER} 99\n`, stderr: '' };
      }
      if (script.includes('tail -c 2000')) {
        return { code: 0, stdout: opts.errTail ?? '', stderr: '' };
      }
      // cancel
      return { code: 0, stdout: '', stderr: '' };
    },
    async stream(_target: string, _script: string, o: SshStreamOptions): Promise<SshExecResult> {
      const lines = opts.streams[streamIdx++] ?? [];
      for (const line of lines) {
        if (o.signal.aborted) break;
        if (o.onLine(line) === 'stop') break;
      }
      return { code: 255, stdout: '', stderr: '' };
    },
  };
}

function makeDeps(runner: SshRunner): RemoteRunDeps {
  return { runner, sleep: async () => undefined };
}

function makeHandle(runner: SshRunner, overrides?: { sessionId?: string; cwd?: string }): RemoteSubagentHandle {
  return new RemoteSubagentHandle({
    id: 'remote-test-1',
    request: {
      target: 'user@box',
      prompt: 'do work',
      runId: 'r1',
      sessionId: overrides?.sessionId ?? 's1',
      cwd: overrides?.cwd,
    },
    deps: makeDeps(runner),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteSubagentHandle', () => {
  describe('initial state', () => {
    it('starts idle with no durationMs', () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      expect(h.status).toBe('idle');
      expect(h.durationMs).toBeUndefined();
    });

    it('exposes id and a session stub', () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      expect(h.id).toBe('remote-test-1');
      expect(h.session).toBeDefined();
      // stub carries the sessionId and cwd
      expect(h.session.sessionId).toBe('s1');
      expect(h.session.cwd).toBeUndefined();
    });

    it('stub session carries cwd when provided', () => {
      const h = makeHandle(fakeRunner({ streams: [] }), { cwd: '~/Projects/x' });
      expect(h.session.cwd).toBe('~/Projects/x');
    });
  });

  describe('run()', () => {
    it('returns a Message with the remote reply and sets status succeeded', async () => {
      const h = makeHandle(fakeRunner({ streams: [[MSG('hello world'), DONE]] }));
      const msg = await h.run('ignored prompt');
      expect(msg.content).toBe('hello world');
      expect(h.status).toBe('succeeded');
      expect(h.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws and sets status failed on remote error event', async () => {
      const h = makeHandle(fakeRunner({ streams: [[ERR_EV('boom')]] }));
      await expect(h.run('x')).rejects.toThrow('remote agent error');
      expect(h.status).toBe('failed');
    });

    it('throws and sets status failed on unreachable host', async () => {
      const h = makeHandle(fakeRunner({ launch: { code: 255, stdout: '', stderr: '' }, streams: [] }));
      await expect(h.run('x')).rejects.toThrow('host unreachable');
      expect(h.status).toBe('failed');
    });

    it('throws when already running', async () => {
      const h = makeHandle(fakeRunner({ streams: [[MSG('a'), DONE]] }));
      // Kick off first run without awaiting
      const first = h.run('x');
      await expect(h.run('y')).rejects.toThrow('already running');
      await first;
    });

    it('throws when cancelled', async () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      await h.cancel();
      await expect(h.run('x')).rejects.toThrow('cancelled');
    });
  });

  describe('runToResult()', () => {
    it('returns succeeded result with message content on done', async () => {
      const h = makeHandle(fakeRunner({ streams: [[MSG('final answer'), DONE]] }));
      const r = await h.runToResult('x');
      expect(r.status).toBe('succeeded');
      expect(r.message?.content).toBe('final answer');
      expect(r.error).toBeUndefined();
    });

    it('returns failed result with partialOutput on remote error', async () => {
      const h = makeHandle(fakeRunner({ streams: [[MSG('partial text'), ERR_EV('oops')]] }));
      const r = await h.runToResult('x');
      expect(r.status).toBe('failed');
      expect(r.error?.message).toMatch('remote agent error');
      expect(r.partialOutput).toBe('partial text');
    });

    it('returns cancelled result when already cancelled', async () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      await h.cancel();
      const r = await h.runToResult('x');
      expect(r.status).toBe('cancelled');
    });

    it('returns failed result on lost connection', async () => {
      // No streams → MAX_RECONNECTS exhausted → kind:lost
      const h = makeHandle(fakeRunner({ streams: [[MSG('partial')]] }));
      const r = await h.runToResult('x');
      expect(r.status).toBe('failed');
      expect(r.partialOutput).toBe('partial');
    });

    it('includes remoteDetail in error message when present', async () => {
      const h = makeHandle(fakeRunner({ streams: [[ERR_EV('oops')]] }));
      const r = await h.runToResult('x');
      expect(r.status).toBe('failed');
      // remoteDetail comes from the error event's message field
      expect(r.error?.message).toContain('remote agent error');
      expect(r.error?.message).toContain('oops');
    });

    it('returns failed result when process exits without a result', async () => {
      const h = makeHandle(fakeRunner({
        streams: [[EXIT_MARKER]],
        errTail: 'Error: not logged in',
      }));
      const r = await h.runToResult('x');
      expect(r.status).toBe('failed');
      expect(r.error?.message).toContain('remote afk exited without a result');
    });
  });

  describe('cancel()', () => {
    it('is idempotent', async () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      await h.cancel();
      await h.cancel(); // must not throw
      expect(h.status).toBe('cancelled');
    });

    it('cancels an in-flight run', async () => {
      // No DONE event — run would hang without cancel.
      // We verify cancellation by checking the handle's own AbortController
      // signal via the session stub (which shares the same signal) and the
      // resulting status, rather than relying on a listener race in the fake.
      const runner: SshRunner = {
        async exec(_t, script) {
          if (script.includes(PID_MARKER)) return { code: 0, stdout: `${PID_MARKER} 7\n`, stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        async stream(_t, _script, o) {
          await new Promise<void>((resolve) => {
            o.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { code: 255, stdout: '', stderr: '' };
        },
      };
      const h = makeHandle(runner);
      const runP = h.runToResult('x');
      await h.cancel();
      const r = await runP;
      // The session stub's abortSignal reflects the handle's controller.
      expect(h.session.abortSignal.aborted).toBe(true);
      expect(['cancelled', 'failed']).toContain(r.status);
    });
  });

  describe('runInBackground()', () => {
    it('calls onResult with a succeeded result', async () => {
      const h = makeHandle(fakeRunner({ streams: [[MSG('bg reply'), DONE]] }));
      const onResult = vi.fn();
      h.runInBackground('x', onResult);
      // Wait for the microtask to complete
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(onResult).toHaveBeenCalledOnce();
      expect(onResult.mock.calls[0]?.[0]).toMatchObject({ status: 'succeeded' });
    });

    it('catches when onResult throws (R1 — no unhandled rejection)', async () => {
      const h = makeHandle(fakeRunner({ streams: [[MSG('bg reply'), DONE]] }));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const throwingCb = (): void => { throw new Error('callback boom'); };
      h.runInBackground('x', throwingCb);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('runInBackground'),
        expect.any(Error),
      );
      spy.mockRestore();
    });
  });

  describe('teardown()', () => {
    it('is a no-op on a succeeded handle', async () => {
      const h = makeHandle(fakeRunner({ streams: [[MSG('done'), DONE]] }));
      await h.run('x');
      await expect(h.teardown()).resolves.toBeUndefined();
    });

    it('cancels a running handle', async () => {
      const runner: SshRunner = {
        async exec(_t, script) {
          if (script.includes(PID_MARKER)) return { code: 0, stdout: `${PID_MARKER} 8\n`, stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
        async stream(_t, _script, o) {
          await new Promise<void>((resolve) => {
            o.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { code: 255, stdout: '', stderr: '' };
        },
      };
      const h = makeHandle(runner);
      const runP = h.runToResult('x');
      await h.teardown();
      await runP;
      expect(['cancelled', 'failed']).toContain(h.status);
    });
  });

  describe('no-op stubs', () => {
    it('sendMessage is a no-op', () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      expect(() => h.sendMessage('hello')).not.toThrow();
    });

    it('steer is a no-op', () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      expect(() => h.steer('steer me')).not.toThrow();
    });

    it('getLastStopInjectContext returns undefined', () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      expect(h.getLastStopInjectContext()).toBeUndefined();
    });

    it('session stub throws on sendMessage', async () => {
      const h = makeHandle(fakeRunner({ streams: [] }));
      await expect(h.session.sendMessage('hi')).rejects.toThrow('not supported');
    });
  });
});
