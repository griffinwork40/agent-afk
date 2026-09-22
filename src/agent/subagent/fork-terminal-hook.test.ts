import { describe, expect, it, vi } from 'vitest';
import type { AbortGraph } from '../abort-graph.js';
import type { OutputEvent } from '../types/session-types.js';
import { makeForkTerminalHook, type ForkTerminalDeps } from './fork-terminal-hook.js';
import type { SubagentHandleImpl } from './handle.js';
import { createEmptyTrace } from './result.js';

describe('makeForkTerminalHook', () => {
  it('deduplicates a terminal callback within one run but records later runs', () => {
    const firstTrace = createEmptyTrace();
    const handle = {
      _currentStatus: 'succeeded',
      _lastDurationMs: 12,
      _currentTrace: firstTrace,
      _lastStopReason: 'end_turn',
    } as SubagentHandleImpl<unknown>;
    const stopOccupancyHeartbeat = vi.fn();
    const recordHandle = vi.fn();
    const sink = vi.fn();
    const deps: ForkTerminalDeps = {
      id: 'child-1',
      stopOccupancyHeartbeat,
      getOutputEventSink: () => sink,
      activeMap: new Map([['child-1', handle]]),
      abortGraph: { dispose: vi.fn() } as unknown as AbortGraph,
      logWriter: undefined,
      completedCache: { recordHandle },
    };
    const hook = makeForkTerminalHook(deps, { current: handle });

    hook();
    hook();

    expect(stopOccupancyHeartbeat).toHaveBeenCalledTimes(1);
    expect(recordHandle).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);

    handle._currentTrace = createEmptyTrace();
    handle._currentStatus = 'failed';
    hook();

    expect(stopOccupancyHeartbeat).toHaveBeenCalledTimes(2);
    expect(recordHandle).toHaveBeenLastCalledWith(
      'child-1',
      handle,
      'failed',
      handle._currentTrace,
      'end_turn',
    );
    expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('resolves a replacement lifecycle sink when termination occurs', () => {
    const staleSink = vi.fn<(event: OutputEvent) => void>();
    const replacementSink = vi.fn<(event: OutputEvent) => void>();
    let currentSink: ((event: OutputEvent) => void) | undefined = staleSink;
    const handle = {
      _currentStatus: 'succeeded',
      _currentTrace: createEmptyTrace(),
      _lastDurationMs: undefined,
      _lastStopReason: undefined,
    } as SubagentHandleImpl<unknown>;
    const hook = makeForkTerminalHook(
      {
        id: 'child-2',
        stopOccupancyHeartbeat: vi.fn(),
        getOutputEventSink: () => currentSink,
        activeMap: new Map(),
        abortGraph: { dispose: vi.fn() } as unknown as AbortGraph,
        logWriter: undefined,
        completedCache: { recordHandle: vi.fn() },
      },
      { current: handle },
    );

    currentSink = replacementSink;
    hook();

    expect(staleSink).not.toHaveBeenCalled();
    expect(replacementSink).toHaveBeenCalledWith(
      expect.objectContaining({ subagentId: 'child-2', status: 'succeeded' }),
    );
  });
});
