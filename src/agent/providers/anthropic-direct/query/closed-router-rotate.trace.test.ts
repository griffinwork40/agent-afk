/** Regression #5077: exercise the producer through real emit + writer/schema. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTraceWriter } from '../../../trace/writer.js';

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { _resetClosedRouterPathCache, tryClosedRouterRotate } from './closed-router-rotate.js';

describe('tryClosedRouterRotate failure traces (real emit + writer/schema)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('AFK_CLOSED_ROUTER', '1');
    _resetClosedRouterPathCache();
    execFileSyncMock.mockReturnValue(Buffer.from('/usr/local/bin/closed-router'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    _resetClosedRouterPathCache();
  });

  it.each([
    { label: 'timeout', code: null, signal: 'SIGTERM', expectedExit: {} },
    { label: 'spawn failure', code: 'ENOENT', signal: null, expectedExit: { exitCode: 'ENOENT' } },
    { label: 'numeric exit', code: 1, signal: null, expectedExit: { exitCode: 1 } },
  ])('persists $label without leaking child error text', async ({ code, signal, expectedExit }) => {
    // These are Node execFile error shapes, not hand-constructed trace payloads.
    const error = Object.assign(new Error('sensitive child stderr'), { code, signal });
    execFileMock.mockImplementation((
      _file: string, _args: string[], _options: unknown, callback: (err: Error) => void,
    ) => callback(error));
    const writer = new InMemoryTraceWriter();

    await expect(tryClosedRouterRotate(writer)).resolves.toEqual({ rotated: false, kind: 'error' });

    expect(execFileMock).toHaveBeenCalledOnce();
    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]).toMatchObject({
      kind: 'session_phase',
      payload: {
        phase: 'closed_router_rotate',
        metadata: { kind: 'error', reason: 'subprocess-failed', ...expectedExit },
      },
    });
    const event = writer.events[0]!;
    if (event.kind !== 'session_phase') throw new Error('expected session_phase');
    expect(event.payload.metadata).toEqual({ kind: 'error', reason: 'subprocess-failed', ...expectedExit });
    expect(JSON.stringify(writer.events)).not.toContain('sensitive child stderr');
  });

  it.each([
    { label: 'missing kind', stdout: '{}', metadata: { kind: 'error', reason: 'unexpected-kind', receivedKind: 'undefined' } },
    { label: 'null output', stdout: 'null', metadata: { kind: 'error', reason: 'unexpected-kind', receivedKind: 'undefined' } },
    { label: 'scalar output', stdout: '42', metadata: { kind: 'error', reason: 'unexpected-kind', receivedKind: 'undefined' } },
    { label: 'non-json output', stdout: 'not json', metadata: { kind: 'error', reason: 'non-json-output' } },
  ])('persists $label with schema-valid metadata', async ({ stdout, metadata }) => {
    execFileMock.mockImplementation((
      _file: string, _args: string[], _options: unknown,
      callback: (err: null, output: { stdout: string; stderr: string }) => void,
    ) => callback(null, { stdout, stderr: '' }));
    const writer = new InMemoryTraceWriter();

    await expect(tryClosedRouterRotate(writer)).resolves.toEqual({ rotated: false, kind: 'error' });

    expect(execFileMock).toHaveBeenCalledOnce();
    expect(writer.events).toHaveLength(1);
    const event = writer.events[0]!;
    expect(event.kind).toBe('session_phase');
    if (event.kind !== 'session_phase') throw new Error('expected session_phase');
    expect(event.payload.phase).toBe('closed_router_rotate');
    expect(event.payload.metadata).toEqual(metadata);
  });

  it('persists binary-not-found without spawning the rotation', async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
    const writer = new InMemoryTraceWriter();

    await expect(tryClosedRouterRotate(writer)).resolves.toEqual({ rotated: false, kind: 'error' });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]).toMatchObject({
      kind: 'session_phase',
      payload: { phase: 'closed_router_rotate', metadata: { kind: 'error', reason: 'binary-not-found' } },
    });
  });
});
