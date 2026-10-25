import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTranscript } from './use-transcript';

vi.mock('@/lib/api', () => ({ getToken: () => 'test-token' }));

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    response: { ok: true, body },
    reset() { controller.enqueue(new TextEncoder().encode('data: {"reset":true}\n\n')); },
    send(id: number | string, record: Record<string, unknown>, replay = false) {
      controller.enqueue(new TextEncoder().encode(`id: ${id}\ndata: ${JSON.stringify({ record, replay })}\n\n`));
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('useTranscript clear generations', () => {
  it('drops old turns/totals and refetches without old Last-Event-ID; late old replay is ignored', async () => {
    const old = stream();
    const fresh = stream();
    const fetch = vi.fn().mockResolvedValueOnce(old.response).mockResolvedValueOnce(fresh.response);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useTranscript('session-1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      old.send(1, { kind: 'user', text: 'old question' }, true);
      old.send(2, { kind: 'done', costUsd: 1, durationMs: 12 }, true);
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.totals.turns).toBe(1);

    act(() => result.current.clear());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(result.current.items).toEqual([]);
    expect(result.current.totals.turns).toBe(0);
    expect(result.current.turnActive).toBe(false);
    expect(result.current.liveTurns).toBe(0);
    const options = fetch.mock.calls[1]![1] as RequestInit;
    expect(options.headers).toEqual({ authorization: 'Bearer test-token' });
    expect((fetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);

    // A non-cooperative reader can still resolve after abort; it must not
    // contaminate the next projection or reuse the old tool/subagent indexes.
    act(() => {
      old.send(3, { kind: 'user', text: 'stale replay' }, true);
      fresh.send(1, { kind: 'user', text: 'new question' });
      fresh.send(2, { kind: 'done', costUsd: 0, durationMs: 1 });
    });
    await waitFor(() => expect(result.current.liveTurns).toBe(1));
    expect(result.current.items).toHaveLength(2);
    expect(JSON.stringify(result.current.items)).toContain('new question');
    expect(JSON.stringify(result.current.items)).not.toMatch(/old question|stale replay/);
  });

  it('server reset clears event history, totals and correlation indexes in-place, including same-chunk records', async () => {
    const source = stream();
    const fetch = vi.fn().mockResolvedValue(source.response);
    vi.stubGlobal('fetch', fetch);
    const reset = vi.fn();
    const { result } = renderHook(() => useTranscript('session-1', reset));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      source.send('old:0', { kind: 'user', text: 'Old generation' });
      source.send('old:1', { kind: 'tool', toolUseId: 'same-tool', name: 'Read', input: {} });
      source.send('old:2', { kind: 'done', costUsd: 5, durationMs: 90 });
    });
    await waitFor(() => expect(result.current.liveTurns).toBe(1));
    act(() => {
      source.reset();
      source.send('new:0', { kind: 'user', text: 'New generation' });
      source.send('new:1', { kind: 'tool_result', toolUseId: 'same-tool', content: 'orphan result' });
      source.send('new:2', { kind: 'done', costUsd: 2, durationMs: 10 });
    });
    await waitFor(() => expect(result.current.totals.costUsd).toBe(2));
    expect(result.current.totals.turns).toBe(1);
    expect(result.current.liveTurns).toBe(1);
    expect(result.current.turnActive).toBe(false);
    expect(JSON.stringify(result.current.items)).not.toContain('Old generation');
    expect(JSON.stringify(result.current.items)).toContain('New generation');
    expect(result.current.items.some((item) => item.kind === 'tool')).toBe(false);
    expect(result.current.items.some((item) => item.kind === 'notice')).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('open');
  });

  it('does not feed the previous session event array into a newly selected session', async () => {
    const old = stream();
    const next = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(old.response).mockResolvedValueOnce(next.response));
    const { result, rerender } = renderHook(({ id }) => useTranscript(id), { initialProps: { id: 'one' } });
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => old.send(1, { kind: 'user', text: 'first session' }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    rerender({ id: 'two' });
    await waitFor(() => expect(result.current.items).toEqual([]));
    act(() => next.send(1, { kind: 'user', text: 'second session' }, true));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(JSON.stringify(result.current.items)).not.toContain('first session');
  });
});
