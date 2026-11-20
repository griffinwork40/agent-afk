/**
 * closed-router-rotate: shells out to `closed-router rotate --once --json --on-limit`
 * on a subscription-limit 429 to rotate to a fresh OAuth account.
 *
 * Coverage:
 *  - env gate: AFK_CLOSED_ROUTER unset → no-action, zero subprocess calls
 *  - each `kind` from closed-router JSON output → correct typed result
 *  - JSON parse failure → error fallback
 *  - exec timeout / error → error fallback, never throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TraceSink } from '../../../trace/writer.js';

// Mock env — must match the specifier the source file uses.
const envMock = vi.hoisted(() => ({ AFK_CLOSED_ROUTER: '1' as string | undefined }));
vi.mock('../../../../config/env.js', () => ({ env: envMock }));

// Mock child_process, preserving originals so vitest internals aren't broken.
const execFileSyncMock = vi.hoisted(() => vi.fn());
const execFileCbMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    execFile: execFileCbMock,
  };
});

// Mock the trace emit so we can assert on emitted session phases.
const emitSessionPhaseMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../trace/emit.js', () => ({ emitSessionPhase: emitSessionPhaseMock }));

/** Minimal no-op TraceSink for passing as traceWriter. */
const noopWriter = {} as TraceSink;

// Dynamic import AFTER mocks are registered.
const { tryClosedRouterRotate, _resetClosedRouterPathCache } = await import('./closed-router-rotate.js');

/** Make the promisified execFile resolve with the given stdout. */
function mockRotateStdout(stdout: string): void {
  execFileCbMock.mockImplementation(
    (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as (err: null, out: { stdout: string; stderr: string }) => void)(
          null, { stdout, stderr: '' },
        );
      }
    },
  );
}

/** Make the promisified execFile reject with an error. */
function mockRotateError(msg: string): void {
  execFileCbMock.mockImplementation(
    (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') {
        (cb as (err: Error) => void)(new Error(msg));
      }
    },
  );
}

describe('tryClosedRouterRotate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.AFK_CLOSED_ROUTER = '1';
    // Default: `which closed-router` succeeds (binary on PATH).
    execFileSyncMock.mockReturnValue(Buffer.from('/usr/local/bin/closed-router'));
  });

  it('returns no-action when AFK_CLOSED_ROUTER is unset', async () => {
    envMock.AFK_CLOSED_ROUTER = undefined;
    const result = await tryClosedRouterRotate();
    expect(result).toEqual({ rotated: false, kind: 'no-action' });
    expect(execFileCbMock).not.toHaveBeenCalled();
  });

  it('returns rotated:true on kind=rotated', async () => {
    mockRotateStdout(JSON.stringify({ kind: 'rotated', message: 'switched', from: 'a', to: 'b' }));
    const result = await tryClosedRouterRotate();
    expect(result).toEqual({ rotated: true, kind: 'rotated' });
  });

  it('returns rotated:true on kind=reset', async () => {
    mockRotateStdout(JSON.stringify({ kind: 'reset', message: 'rate limit cleared' }));
    const result = await tryClosedRouterRotate();
    expect(result).toEqual({ rotated: true, kind: 'reset' });
  });

  it('returns rotated:false on kind=no-action', async () => {
    mockRotateStdout(JSON.stringify({ kind: 'no-action', message: 'below threshold' }));
    const result = await tryClosedRouterRotate();
    expect(result).toEqual({ rotated: false, kind: 'no-action' });
  });

  it('returns rotated:false on kind=all-hot', async () => {
    mockRotateStdout(JSON.stringify({ kind: 'all-hot', message: 'all accounts above threshold' }));
    const result = await tryClosedRouterRotate();
    expect(result).toEqual({ rotated: false, kind: 'all-hot' });
  });

  it('returns error on non-JSON output', async () => {
    mockRotateStdout('not json at all');
    const result = await tryClosedRouterRotate(noopWriter);
    expect(result).toEqual({ rotated: false, kind: 'error' });
    expect(emitSessionPhaseMock).toHaveBeenCalledWith(
      noopWriter,
      expect.objectContaining({ phase: 'closed_router_rotate', metadata: expect.objectContaining({ reason: 'non-json-output' }) }),
    );
  });

  it('returns error on unknown kind', async () => {
    mockRotateStdout(JSON.stringify({ kind: 'unknown-future-kind' }));
    const result = await tryClosedRouterRotate(noopWriter);
    expect(result).toEqual({ rotated: false, kind: 'error' });
    expect(emitSessionPhaseMock).toHaveBeenCalledWith(
      noopWriter,
      expect.objectContaining({ phase: 'closed_router_rotate', metadata: expect.objectContaining({ reason: 'unexpected-kind' }) }),
    );
  });

  it('returns error and never throws on exec failure', async () => {
    mockRotateError('Command timed out');
    const result = await tryClosedRouterRotate(noopWriter);
    expect(result).toEqual({ rotated: false, kind: 'error' });
    expect(emitSessionPhaseMock).toHaveBeenCalledWith(
      noopWriter,
      expect.objectContaining({ phase: 'closed_router_rotate', metadata: expect.objectContaining({ reason: 'subprocess-failed' }) }),
    );
    // Raw error message must NOT be recorded — credential material could appear there.
    const call = emitSessionPhaseMock.mock.calls.find(
      (c) => (c[1] as { phase: string }).phase === 'closed_router_rotate',
    );
    expect(JSON.stringify(call)).not.toContain('Command timed out');
  });

  it('returns error when binary is not on PATH', async () => {
    // Reset positive-only cache so this test re-checks PATH.
    _resetClosedRouterPathCache();
    execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
    const result = await tryClosedRouterRotate(noopWriter);
    expect(result).toEqual({ rotated: false, kind: 'error' });
    expect(emitSessionPhaseMock).toHaveBeenCalledWith(
      noopWriter,
      expect.objectContaining({ phase: 'closed_router_rotate', metadata: expect.objectContaining({ reason: 'binary-not-found' }) }),
    );
    // execFile (the async spawn) must NOT have been called — gate failed before subprocess.
    expect(execFileCbMock).not.toHaveBeenCalled();
  });
});
