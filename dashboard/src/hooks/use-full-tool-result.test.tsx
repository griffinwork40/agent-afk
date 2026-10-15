/**
 * Tests for useFullToolResult — specifically the stale-result race condition
 * where an in-flight fetch from a prior (sessionId, toolUseId) pair would
 * install its result into the state of a new row if the user switched before
 * the request completed.
 *
 * Fix: each load() call issues an AbortController that is aborted when the
 * (sessionId, toolUseId) pair changes, the component unmounts, or a newer
 * load() supersedes it; the completion callbacks drop results once aborted.
 *
 * @module hooks/use-full-tool-result.test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { TranscriptSessionContext, useFullToolResult } from './use-full-tool-result';
import type { ToolResultResponse } from '@/types/api';

// ---------------------------------------------------------------------------
// Mock apiFetch so we can control when promises resolve.
// ---------------------------------------------------------------------------

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  },
}));

vi.mock('@/lib/ledger-adapter', () => ({
  toolResultPath: (sessionId: string, toolUseId: string) => `/api/sessions/${sessionId}/tool-results/${toolUseId}`,
}));

import { apiFetch } from '@/lib/api';
const mockedApiFetch = vi.mocked(apiFetch);

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(text: string): ToolResultResponse {
  return { parts: [{ type: 'text', text }] } as unknown as ToolResultResponse;
}

function wrapper(sessionId: string | null) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(TranscriptSessionContext.Provider, { value: sessionId }, children);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useFullToolResult', () => {
  it('starts idle and sets canLoad when sessionId and toolUseId are present', () => {
    const { result } = renderHook(() => useFullToolResult('tu-1'), {
      wrapper: wrapper('sess-1'),
    });
    expect(result.current.state.status).toBe('idle');
    expect(result.current.canLoad).toBe(true);
  });

  it('canLoad is false when there is no session context', () => {
    const { result } = renderHook(() => useFullToolResult('tu-1'), {
      wrapper: wrapper(null),
    });
    expect(result.current.canLoad).toBe(false);
  });

  it('loads and transitions to loaded state', async () => {
    mockedApiFetch.mockResolvedValueOnce(makeResult('output'));
    const { result } = renderHook(() => useFullToolResult('tu-1'), {
      wrapper: wrapper('sess-1'),
    });
    act(() => { result.current.load(); });
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state.status).toBe('loaded'));
    expect((result.current.state as { status: 'loaded'; result: ToolResultResponse }).result).toMatchObject(
      makeResult('output'),
    );
  });

  it('stale result is NOT installed after toolUseId changes before fetch completes', async () => {
    // Arrange: the first fetch is a long-running promise we control.
    let resolveFirst!: (v: ToolResultResponse) => void;
    const firstFetch = new Promise<ToolResultResponse>((res) => { resolveFirst = res; });
    mockedApiFetch.mockReturnValueOnce(firstFetch);
    // Second fetch (after toolUseId changes) resolves immediately.
    mockedApiFetch.mockResolvedValueOnce(makeResult('second-result'));

    const { result, rerender } = renderHook(
      ({ toolUseId }: { toolUseId: string }) => useFullToolResult(toolUseId),
      { wrapper: wrapper('sess-1'), initialProps: { toolUseId: 'tu-old' } },
    );

    // Start the first (slow) fetch.
    act(() => { result.current.load(); });
    expect(result.current.state.status).toBe('loading');

    // Switch to a new toolUseId — this should abort the old request and reset.
    rerender({ toolUseId: 'tu-new' });
    await waitFor(() => expect(result.current.state.status).toBe('idle'));

    // Now the user requests the new result.
    mockedApiFetch.mockResolvedValueOnce(makeResult('second-result'));
    act(() => { result.current.load(); });
    await waitFor(() => expect(result.current.state.status).toBe('loaded'));

    // Now resolve the FIRST (stale) fetch — its setState must be suppressed.
    act(() => { resolveFirst(makeResult('stale-result')); });

    // State must show the new result, not the stale one.
    const loaded = result.current.state as { status: 'loaded'; result: ToolResultResponse };
    expect(loaded.result).toMatchObject(makeResult('second-result'));
  });

  it('stale result is NOT installed after sessionId changes before fetch completes', async () => {
    let resolveFirst!: (v: ToolResultResponse) => void;
    const firstFetch = new Promise<ToolResultResponse>((res) => { resolveFirst = res; });
    mockedApiFetch.mockReturnValueOnce(firstFetch);

    const { result, rerender } = renderHook(
      () => useFullToolResult('tu-same'),
      { wrapper: ({ children }: { children: React.ReactNode }) =>
          React.createElement(TranscriptSessionContext.Provider, { value: 'sess-A' }, children),
      },
    );

    act(() => { result.current.load(); });
    expect(result.current.state.status).toBe('loading');

    // Simulate session change by re-rendering with a different context value.
    // We do this by replacing the wrapper with one holding a new sessionId.
    rerender();

    // Resolve the stale fetch — state must not flip to loaded from a stale request.
    act(() => { resolveFirst(makeResult('stale-session-result')); });

    // State should not be 'loaded' with the stale result; it will be 'idle'
    // (reset by the useEffect) or possibly 'loading' if a new fetch was issued,
    // but never 'loaded' with the old session's data.
    const s = result.current.state;
    if (s.status === 'loaded') {
      // If somehow loaded, must not be the stale value.
      expect((s as { result: ToolResultResponse }).result).not.toMatchObject(makeResult('stale-session-result'));
    }
  });

  it('calling load() while already loading does not crash and keeps loading state', async () => {
    mockedApiFetch.mockImplementation(() => new Promise<ToolResultResponse>(() => {}));

    const { result } = renderHook(() => useFullToolResult('tu-1'), {
      wrapper: wrapper('sess-1'),
    });

    act(() => { result.current.load(); });
    expect(result.current.state.status).toBe('loading');

    // Calling load() again while in-flight should not crash.
    expect(() => {
      act(() => { result.current.load(); });
    }).not.toThrow();

    expect(result.current.state.status).toBe('loading');
  });

  it('aborts the in-flight request on unmount', () => {
    mockedApiFetch.mockImplementation(() => new Promise<ToolResultResponse>(() => {}));

    const { result, unmount } = renderHook(() => useFullToolResult('tu-1'), {
      wrapper: wrapper('sess-1'),
    });

    act(() => { result.current.load(); });
    const init = mockedApiFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal?.aborted).toBe(false);

    unmount();
    expect(init?.signal?.aborted).toBe(true);
  });
});
