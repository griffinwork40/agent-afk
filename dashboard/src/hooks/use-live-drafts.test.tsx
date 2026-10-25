import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTranscript } from './use-transcript';
import { TranscriptView } from '@/components/transcript-view';
import { fenceSafeLength } from '@/components/streaming-text';

vi.mock('@/lib/api', () => ({ getToken: () => 'test-token' }));

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const enc = new TextEncoder();
  return {
    response: { ok: true, body },
    record(id: string, record: Record<string, unknown>, replay = false) {
      controller.enqueue(enc.encode(`id: ${id}\ndata: ${JSON.stringify({ record, replay })}\n\n`));
    },
    live(payload: Record<string, unknown>) { controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`)); },
    reset() { controller.enqueue(enc.encode('data: {"reset":true}\n\n')); },
    close() { controller.close(); },
  };
}

afterEach(() => vi.unstubAllGlobals());

const texts = (items: { kind: string; text?: string }[]) => items.map((i) => `${i.kind}:${i.text ?? ''}`);

describe('live drafts', () => {
  it('renders A -> tool -> B in order, each once, and durable records take over the draft ids', async () => {
    const s = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const { result } = renderHook(() => useTranscript('s1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      s.record('g:0', { kind: 'user', text: 'go' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'ALP' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 3, text: 'HA' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['user:go', 'assistant:ALPHA']));
    const draftId = result.current.items[1]!.id;
    act(() => {
      s.live({ type: 'live_seal', seg: 0, part: 'text' });
      s.record('g:1', { kind: 'assistant', seg: 0, text: 'ALPHA' });
      s.record('g:2', { kind: 'tool', toolUseId: 't', toolName: 'bash', input: 'echo' });
      s.live({ type: 'live_delta', seg: 1, part: 'text', offset: 0, text: 'OMEGA' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['user:go', 'assistant:ALPHA', 'tool:', 'assistant:OMEGA']));
    expect(result.current.items[1]!.id).toBe(draftId);
    act(() => {
      s.record('g:3', { kind: 'assistant', seg: 1, text: 'OMEGA' });
      s.live({ type: 'live_end', reason: 'done' });
      s.record('g:4', { kind: 'done' });
    });
    await waitFor(() => expect(result.current.turnActive).toBe(false));
    expect(texts(result.current.items.filter((i) => i.kind !== 'notice'))).toEqual(['user:go', 'assistant:ALPHA', 'tool:', 'assistant:OMEGA']);
  });

  it('drops duplicate deltas, waits for a snapshot after a gap, and a boundary+snapshot gives no dupes', async () => {
    const s = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const { result } = renderHook(() => useTranscript('s1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'abc' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'abc' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 9, text: 'gap' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 3, text: 'def' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['assistant:abc']));
    act(() => {
      s.reset();
      s.live({ type: 'live_snapshot', seg: 0, part: 'text', text: 'abcdefghi' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['assistant:abcdefghi']));
  });

  it('an aborted turn keeps its unmatched draft as an interrupted item', async () => {
    const s = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const { result } = renderHook(() => useTranscript('s1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'half' });
      s.live({ type: 'live_end', reason: 'aborted' });
    });
    await waitFor(() => expect((result.current.items[0] as { live?: string } | undefined)?.live).toBe('interrupted'));
  });
});

describe('live drafts across back-to-back turns', () => {
  // Observed server order (probe .afk/probe-frames.json): live_seal, live_end,
  // THEN the durable assistant{seg} record (ledger tail poll), THEN done.
  it('streams turns 1, 2 and 3 live: each turn\'s draft grows before its durable record', async () => {
    const s = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const { result } = renderHook(() => useTranscript('s1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    let id = 0;
    const draftText = () => result.current.items.filter((i) => (i as { live?: string }).live === 'streaming').map((i) => (i as { text?: string }).text).join('');
    for (let turn = 1; turn <= 3; turn++) {
      act(() => { s.record(`g:${id++}`, { kind: 'user', text: `q${turn}` }); });
      const seen: string[] = [];
      let off = 0;
      for (const piece of [`T${turn}a`, 'bb', 'cc']) {
        act(() => { s.live({ type: 'live_delta', turn, seg: 0, part: 'text', offset: off, text: piece }); });
        off += piece.length;
        await waitFor(() => expect(draftText().length).toBe(off));
        seen.push(draftText());
      }
      expect(new Set(seen).size).toBe(3);
      act(() => {
        s.live({ type: 'live_seal', turn, seg: 0, part: 'text' });
        s.live({ type: 'live_end', turn, reason: 'done' });
      });
      act(() => {
        s.record(`g:${id++}`, { kind: 'assistant', seg: 0, text: `T${turn}abbcc` });
        s.record(`g:${id++}`, { kind: 'done' });
      });
      await waitFor(() => expect(result.current.turnActive).toBe(false));
    }
    expect(texts(result.current.items.filter((i) => i.kind !== 'notice'))).toEqual([
      'user:q1', 'assistant:T1abbcc', 'user:q2', 'assistant:T2abbcc', 'user:q3', 'assistant:T3abbcc']);
  });

  it('a late durable record of turn N claims turn N\'s draft, not turn N+1\'s', async () => {
    const s = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const { result } = renderHook(() => useTranscript('s1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      s.record('g:0', { kind: 'user', text: 'q1' });
      s.live({ type: 'live_delta', turn: 1, seg: 0, part: 'text', offset: 0, text: 'ONE' });
      s.live({ type: 'live_end', turn: 1, reason: 'done' });
      s.live({ type: 'live_delta', turn: 2, seg: 0, part: 'text', offset: 0, text: 'TWO' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['user:q1', 'assistant:ONE', 'assistant:TWO']));
    const twoId = result.current.items[2]!.id;
    act(() => { s.record('g:1', { kind: 'assistant', seg: 0, text: 'ONE' }); });
    await waitFor(() => expect(result.current.items.filter((i) => i.kind === 'assistant')).toHaveLength(2));
    const two = result.current.items.find((i) => i.id === twoId) as { live?: string; text?: string };
    expect(two.live).toBe('streaming');
    act(() => { s.live({ type: 'live_delta', turn: 2, seg: 0, part: 'text', offset: 3, text: '!!' }); });
    await waitFor(() => expect((result.current.items.find((i) => i.id === twoId) as { text?: string }).text).toBe('TWO!!'));
  });
});

describe('draft -> durable handover in the DOM', () => {
  it('keeps the same DOM node when the durable record replaces the draft, and durable text is not animated', () => {
    const draft = [{ kind: 'assistant' as const, id: 'live-1', text: 'Hello wor', live: 'streaming' }];
    const { container, rerender } = render(<TranscriptView items={draft} />);
    const node = container.querySelector('[data-live="streaming"]');
    expect(node).toBeTruthy();
    expect(container.querySelector('.streaming-cursor')).toBeTruthy();
    rerender(<TranscriptView items={[{ kind: 'assistant', id: 'live-1', text: 'Hello world' }]} />);
    const after = [...container.querySelectorAll('div')].find((d) => d.textContent?.includes('Hello world') && d.parentElement === node?.parentElement);
    expect(after).toBe(node);
    expect(container.querySelector('.streaming-cursor')).toBeNull();
    expect(container.textContent).toContain('Hello world');
  });

  it('holds back a half-typed code fence line while streaming', () => {
    expect(fenceSafeLength('intro\n```ty')).toBe('intro\n'.length);
    expect(fenceSafeLength('intro\n```ts\ncode')).toBe('intro\n```ts\ncode'.length);
  });
});
