import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTranscript } from './use-transcript';

vi.mock('@/lib/api', () => ({ getToken: () => 'token' }));
afterEach(() => vi.unstubAllGlobals());

it('reconstructs choices and progress from SSE, settles other tabs and clears on reset', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, body: new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }),
  }));
  const { result } = renderHook(() => useTranscript('one'));
  await waitFor(() => expect(result.current.status).toBe('open'));
  const send = (value: unknown) => source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  act(() => {
    send({ type: 'choice_request', request: { corrId: 'a', title: 'Choose', options: [{ value: 'x', label: 'X' }] } });
    send({ type: 'progress', corrId: 'b', phase: 'start', label: 'Compacting', fraction: 0.25 });
  });
  await waitFor(() => expect(result.current.choices).toHaveLength(1));
  expect(result.current.choices[0]?.cancellable).toBeUndefined();
  expect(result.current.progress).toEqual([{ corrId: 'b', label: 'Compacting', fraction: 0.25 }]);
  expect(result.current.items).toEqual([]);
  act(() => {
    send({ type: 'choice_settled', corrId: 'a' });
    send({ type: 'progress', corrId: 'b', phase: 'end', label: 'Compacting' });
  });
  await waitFor(() => expect(result.current.choices).toEqual([]));
  expect(result.current.progress).toEqual([]);
  act(() => {
    send({ type: 'choice_request', request: { corrId: 'c', title: 'Choose again', options: [{ value: 'y', label: 'Y' }], cancellable: true } });
    send({ type: 'progress', corrId: 'd', phase: 'update', label: 'Loading' });
  });
  await waitFor(() => expect(result.current.choices).toHaveLength(1));
  act(() => source.enqueue(new TextEncoder().encode('data: {"reset":true}\n\n')));
  await waitFor(() => expect(result.current.choices).toEqual([]));
  expect(result.current.progress).toEqual([]);
});

it('drops pending choices and progress on navigation and reconnects to the selected session', async () => {
  const sources: ReadableStreamDefaultController<Uint8Array>[] = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({
    ok: true, body: new ReadableStream<Uint8Array>({ start(controller) { sources.push(controller); } }),
  })));
  const { result, rerender } = renderHook(({ id }) => useTranscript(id), { initialProps: { id: 'one' } });
  await waitFor(() => expect(result.current.status).toBe('open'));
  act(() => sources[0]!.enqueue(new TextEncoder().encode(
    'data: {"type":"choice_request","request":{"corrId":"old","title":"Old","options":[{"value":"a","label":"A"}]}}\n\n',
  )));
  await waitFor(() => expect(result.current.choices).toHaveLength(1));
  rerender({ id: 'two' });
  await waitFor(() => expect(sources).toHaveLength(2));
  expect(result.current.choices).toEqual([]);
  expect(result.current.progress).toEqual([]);
});
