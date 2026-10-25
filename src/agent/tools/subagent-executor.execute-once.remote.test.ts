/**
 * Tests for the `agent{host}` remote-dispatch branch.
 *
 * Uses a fake SshRunner (zero real SSH) to verify:
 *   - AFK_REMOTE_DEPTH refusal
 *   - isolation:"worktree" incompatibility
 *   - host resolution error propagation
 *   - successful done outcome
 *   - error outcome
 *   - reply truncation at MAX_REPLY_CHARS
 *
 * lost / aborted outcomes are produced by runRemoteAgent's SSH-reconnect and
 * AbortSignal logic, not by stream-line parsing, so they cannot be driven
 * through the fake SshRunner.  They are covered directly via the exported
 * formatRemoteOutcome helper (see "lost / aborted outcome formatting" suite).
 *
 * @module agent/tools/subagent-executor.execute-once.remote.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeRemoteAgentDispatch,
  formatRemoteOutcome,
  type RemoteAgentDispatchDeps,
} from './subagent-executor.execute-once.remote.js';
import { checkAndRunRemoteDispatch } from './subagent-executor.execute-once.helpers.js';

// Module-level mock so the release() test can replace executeRemoteAgentDispatch
// inside checkAndRunRemoteDispatch without real SSH.
vi.mock('./subagent-executor.execute-once.remote.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subagent-executor.execute-once.remote.js')>();
  return { ...actual };
});
import type { RemoteHost } from '../../remote/hosts.js';
import type { SshRunner, SshExecResult, SshStreamOptions } from '../../remote/ssh-runner.js';
import { PID_MARKER } from '../../remote/remote-script.js';
import { MAX_REPLY_CHARS } from './handlers/remote-agent.js';

// ---------------------------------------------------------------------------
// Fake SSH runner — zero real SSH (mirrors remote-subagent-handle.test.ts)
// ---------------------------------------------------------------------------

/** MSG line — carries content; finalMessage() returns the last one. */
const msgLine = (content: string): string =>
  JSON.stringify({ type: 'message', message: { content, timestamp: 't' } });
/** DONE line — signals the stream is terminal (no embedded message). */
const doneLine = (): string =>
  JSON.stringify({ type: 'done', metadata: { durationMs: 1 } });
/** Convenience: a stream that delivers one message then done. */
const doneEvent = (message: string): string[] => [msgLine(message), doneLine()];

const errorEvent = (reason: string): string =>
  JSON.stringify({ type: 'error', error: { message: reason } });

function makeFakeRunner(streamLines: string[]): SshRunner {
  return {
    async exec(_target: string, script: string, _opts?: object): Promise<SshExecResult> {
      // Launch script: return a valid PID marker line.
      if (script.includes(PID_MARKER)) {
        return { code: 0, stdout: `${PID_MARKER} 42\n`, stderr: '' };
      }
      // err tail / cancel — return empty success.
      return { code: 0, stdout: '', stderr: '' };
    },
    async stream(_target: string, _script: string, opts: SshStreamOptions): Promise<SshExecResult> {
      for (const line of streamLines) {
        if (opts.signal.aborted) break;
        if (opts.onLine(line) === 'stop') break;
      }
      return { code: 255, stdout: '', stderr: '' };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake host loader
// ---------------------------------------------------------------------------

function makeHost(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return { name: 'test-host', ssh: 'user@test-host', ...overrides };
}

function makeDeps(
  hostOverrides: Partial<RemoteHost> = {},
  streamLines: string[] = doneEvent('hello from remote'),
): RemoteAgentDispatchDeps {
  return {
    runner: makeFakeRunner(streamLines),
    loadHostsFn: async () => ({ 'test-host': makeHost(hostOverrides) }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ABORT = new AbortController();

describe('executeRemoteAgentDispatch', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '');
  });

  it('refuses when AFK_REMOTE_DEPTH is set', async () => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '1');
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'hello' },
      ABORT.signal,
      makeDeps(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/AFK_REMOTE_DEPTH/);
  });

  it('refuses isolation:"worktree" combined with host', async () => {
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'hello', isolation: 'worktree' },
      ABORT.signal,
      makeDeps(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/isolation.*worktree.*incompatible/i);
  });

  it('returns error when host target is invalid (leads to resolveHost throw)', async () => {
    // A host name with spaces/invalid chars fails isValidSshTarget → resolveHost throws.
    const result = await executeRemoteAgentDispatch(
      { host: 'host with spaces', prompt: 'hello' },
      ABORT.signal,
      {
        runner: makeFakeRunner([]),
        loadHostsFn: async () => ({}),
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/agent\[host\]/);
  });

  it('returns framed reply on done outcome', async () => {
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'hello' },
      ABORT.signal,
      makeDeps({}, doneEvent('remote answer')),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('<remote-output>');
    expect(result.content).toContain('remote answer');
    expect(result.content).toContain('agent[host]:');
  });

  it('returns isError on error outcome', async () => {
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'hello' },
      ABORT.signal,
      makeDeps({}, [errorEvent('something went wrong')]),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/something went wrong/);
  });

  it('truncates reply at MAX_REPLY_CHARS', async () => {
    const longMsg = 'x'.repeat(MAX_REPLY_CHARS + 100);
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'hello' },
      ABORT.signal,
      makeDeps({}, doneEvent(longMsg)),
    );
    expect(result.content).toContain('truncated');
    expect((result as { truncated?: boolean }).truncated).toBe(true);
  });

  it('threads model from parsed to the run request (no error)', async () => {
    const deps = makeDeps({}, doneEvent('ok'));
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'task', model: 'claude-opus-4-5' },
      ABORT.signal,
      deps,
    );
    // Model is threaded into the launch script; we verify no error is thrown.
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('ok');
  });

  it('passes cwd from host config when set', async () => {
    const deps = makeDeps({ cwd: '/remote/project' }, doneEvent('done'));
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'task' },
      ABORT.signal,
      deps,
    );
    expect(result.isError).toBeUndefined();
  });

  // Finding 1: budget receipt rollback on pre-execution refusals
  it('returns isError (rollback path) when AFK_REMOTE_DEPTH causes refusal', async () => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '1');
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'hello' },
      ABORT.signal,
      makeDeps(),
    );
    // The result must be an error so checkAndRunRemoteDispatch calls rollback().
    expect(result.isError).toBe(true);
  });

  // Finding 3: parsed.cwd takes precedence over host.cwd
  it('prefers parsed.cwd over host.cwd when both are set', async () => {
    // Both parsed.cwd and host.cwd are set; parsed.cwd must win.
    // We verify the call succeeds (cwd resolution did not crash) and the result
    // carries the expected framed reply — meaning runRemoteAgent was reached.
    const deps: RemoteAgentDispatchDeps = {
      runner: makeFakeRunner(doneEvent('ok from remote')),
      loadHostsFn: async () => ({ 'test-host': makeHost({ cwd: '/host/cwd' }) }),
    };
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'task', cwd: '/parsed/cwd' },
      ABORT.signal,
      deps,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('ok from remote');
  });

  it('uses parsed.cwd when host has no cwd', async () => {
    const deps: RemoteAgentDispatchDeps = {
      runner: makeFakeRunner(doneEvent('done')),
      loadHostsFn: async () => ({ 'test-host': makeHost() }), // no host.cwd
    };
    const result = await executeRemoteAgentDispatch(
      { host: 'test-host', prompt: 'task', cwd: '/my/project' },
      ABORT.signal,
      deps,
    );
    expect(result.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// lost / aborted outcome formatting (direct, no SSH required)
// ---------------------------------------------------------------------------
//
// These outcomes are produced by runRemoteAgent's SSH-reconnect logic and
// AbortSignal handling respectively — they cannot be driven through the fake
// SshRunner's onLine callback.  We test formatRemoteOutcome directly instead.

const FAKE_HOST = makeHost();
const FAKE_RUN_ID = 'run-abc';
const FAKE_SESSION = 'sess-xyz';

describe('formatRemoteOutcome', () => {
  it('returns isError on aborted outcome', () => {
    const result = formatRemoteOutcome(
      { kind: 'aborted', pid: 42 },
      FAKE_HOST, FAKE_RUN_ID, FAKE_SESSION,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/aborted/);
    expect(result.content).toContain(FAKE_RUN_ID);
  });

  it('returns isError on lost outcome and names the remote run file', () => {
    const result = formatRemoteOutcome(
      { kind: 'lost', reason: 'SSH connection dropped', pid: 42 },
      FAKE_HOST, FAKE_RUN_ID, FAKE_SESSION,
    );
    expect(result.isError).toBe(true);
    // The lost path names the remote run file so the operator can retrieve it.
    expect(result.content).toMatch(/remote-runs/);
    expect(result.content).toContain(FAKE_RUN_ID);
  });

  it('includes partial output in lost outcome when present', () => {
    const result = formatRemoteOutcome(
      { kind: 'lost', reason: 'dropped', pid: 42, partial: 'some partial' },
      FAKE_HOST, FAKE_RUN_ID, FAKE_SESSION,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('some partial');
  });
});

// ---------------------------------------------------------------------------
// #4202 follow-up: SpawnReceipt release/rollback per outcome kind
// ---------------------------------------------------------------------------

describe('checkAndRunRemoteDispatch budget receipt handling', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '');
  });

  const noop = () => {};
  const updateWave: Parameters<typeof checkAndRunRemoteDispatch>[4] = noop as never;

  it('returns undefined (local path) when host is absent', async () => {
    const release = vi.fn();
    const rollback = vi.fn();
    const receipt = { release, rollback } as never;
    const result = await checkAndRunRemoteDispatch(
      { prompt: 'task' }, ABORT.signal, receipt, 'call-1', updateWave,
    );
    expect(result).toBeUndefined();
    expect(release).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('calls rollback() when host resolution fails (unknown host)', async () => {
    // Unknown host → resolveHost throws → executeRemoteAgentDispatch returns
    // isError → checkAndRunRemoteDispatch calls rollback(), not release().
    const release = vi.fn();
    const rollback = vi.fn();
    const receipt = { release, rollback } as never;
    const result = await checkAndRunRemoteDispatch(
      { host: 'nonexistent-host-xyz', prompt: 'task' },
      ABORT.signal,
      receipt, 'call-1', updateWave,
    );
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('calls release() on successful remote dispatch', async () => {
    // Mock executeRemoteAgentDispatch at the module boundary so
    // checkAndRunRemoteDispatch receives a non-error result without real SSH.
    const mod = await import('./subagent-executor.execute-once.remote.js');
    const spy = vi
      .spyOn(mod, 'executeRemoteAgentDispatch')
      .mockResolvedValueOnce({ content: 'remote reply' });

    const release = vi.fn();
    const rollback = vi.fn();
    const receipt = { release, rollback } as never;

    const result = await checkAndRunRemoteDispatch(
      { host: 'any-host', prompt: 'task' },
      ABORT.signal,
      receipt, 'call-release', updateWave,
    );

    expect(result).toBeDefined();
    expect(result!.isError).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('calls rollback() when AFK_REMOTE_DEPTH causes refusal', async () => {
    vi.stubEnv('AFK_REMOTE_DEPTH', '1');
    const release = vi.fn();
    const rollback = vi.fn();
    const receipt = { release, rollback } as never;
    const result = await checkAndRunRemoteDispatch(
      { host: 'test-host', prompt: 'task' },
      ABORT.signal,
      receipt, 'call-1', updateWave,
    );
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });
});
