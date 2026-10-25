import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSseStream } from './use-sse-stream';

vi.mock('@/lib/api', () => ({ getToken: () => 'token' }));
afterEach(() => vi.unstubAllGlobals());

it('drops stale ephemeral requests on reconnect but retains ledger history and new snapshots', async () => {
  let old!: ReadableStreamDefaultController<Uint8Array>;
  let fresh!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true,
    body: new ReadableStream<Uint8Array>({ start(controller) { old = controller; } }),
  }).mockResolvedValueOnce({ ok: true,
    body: new ReadableStream<Uint8Array>({ start(controller) { fresh = controller; } }),
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useSseStream('one'));
  await waitFor(() => expect(result.current.status).toBe('open'));
  act(() => old.enqueue(new TextEncoder().encode('data: {"type":"choice_request","request":{"corrId":"old"}}\n\n')));
  await waitFor(() => expect(result.current.events).toHaveLength(1));
  act(() => old.close());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { timeout: 2000 });
  await waitFor(() => expect(result.current.events).toContainEqual({ type: 'choice_stream_boundary' }));
  act(() => fresh.enqueue(new TextEncoder().encode('data: {"type":"choice_request","request":{"corrId":"new"}}\n\n')));
  await waitFor(() => expect(result.current.events).toHaveLength(3));
});

it('drops pre-reset payloads and resumes with the new opaque cursor without reopening at reset', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    body: new ReadableStream<Uint8Array>({ start(value) { controller = value; } }),
  }).mockResolvedValueOnce({
    ok: true, body: new ReadableStream<Uint8Array>({ start() {} }),
  });
  vi.stubGlobal('fetch', fetch);
  const reset = vi.fn();
  const { result } = renderHook(() => useSseStream('one', 0, reset));
  await waitFor(() => expect(result.current.status).toBe('open'));
  act(() => controller.enqueue(new TextEncoder().encode(
    'id: old-inode:9\ndata: {"old":true}\n\n' +
    'data: {"reset":true}\n\n' +
    'id: 42-opaque-inode:0\ndata: {"fresh":true}\n\n',
  )));
  await waitFor(() => expect(result.current.events).toEqual([{ fresh: true }]));
  expect(result.current.generation).toBe(1);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((fetch.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(false);
  act(() => controller.close());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), { timeout: 2000 });
  expect((fetch.mock.calls[1]![1] as RequestInit).headers).toEqual({
    authorization: 'Bearer token', 'last-event-id': '42-opaque-inode:0',
  });
});
