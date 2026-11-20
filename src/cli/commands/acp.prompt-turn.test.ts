import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OutputEvent } from '../../agent/types/session-types.js';
import type { SessionUpdate, TranslatorState } from './acp.wire.js';

vi.mock('./acp.translate.js', () => ({
  createTranslatorState: vi.fn(),
  translateOutputEvent: vi.fn(),
  finishTurn: vi.fn(),
}));

import * as translate from './acp.translate.js';
import {
  AcpTurnFailed, cancelTurn, makeEmitToolCall, runPromptTurn, type LiveSession,
} from './acp.prompt-turn.js';
import type { AcpSessionHandle } from './acp.session.js';

const mTranslate = vi.mocked(translate.translateOutputEvent);
const mFinish = vi.mocked(translate.finishTurn);

function chunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

function makeLive(stream: () => AsyncIterable<OutputEvent>): { live: LiveSession; interrupt: ReturnType<typeof vi.fn> } {
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const handle = { session: { sendMessageStream: vi.fn(stream), interrupt } } as unknown as AcpSessionHandle;
  const translator: TranslatorState = { tools: new Map(), cancelled: true };
  return { live: { id: 's1', cwd: '/w', handle, translator, closing: false }, interrupt };
}

function makePeer() {
  const sent: unknown[] = [];
  return { sent, peer: { request: vi.fn(), notify: vi.fn(async (_m: string, p: unknown) => { sent.push(p); }) } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mTranslate.mockImplementation((ev) =>
    ev.type === 'chunk' && ev.chunk.type === 'content' ? [chunk(ev.chunk.content)] : []);
  mFinish.mockImplementation(() => ({ updates: [{ sessionUpdate: 'usage_update', used: 1, size: 2 }], stopReason: 'end_turn' }));
});

describe('runPromptTurn', () => {
  it('translates events in order, flushes finishTurn once, returns its stop reason', async () => {
    const meta = { totalCostUsd: 0.01 };
    const { live } = makeLive(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: 'a' } } as OutputEvent;
      yield { type: 'chunk', chunk: { type: 'content', content: 'b' } } as OutputEvent;
      yield { type: 'done', metadata: meta } as OutputEvent;
    });
    const { peer, sent } = makePeer();
    const reason = await runPromptTurn(live, 'hi', { peer, log: () => {} });
    expect(reason).toBe('end_turn');
    expect(live.translator.cancelled).toBe(false);
    expect(mFinish).toHaveBeenCalledTimes(1);
    expect(mFinish).toHaveBeenCalledWith(live.translator, meta);
    expect(sent).toEqual([
      { sessionId: 's1', update: chunk('a') },
      { sessionId: 's1', update: chunk('b') },
      { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 1, size: 2 } },
    ]);
    expect(live.active).toBeUndefined();
  });

  it('throws AcpTurnFailed on a stream error and logs only to the logger', async () => {
    const log = vi.fn();
    const { live } = makeLive(async function* () {
      yield { type: 'error', error: new Error('provider secret sk-123') } as OutputEvent;
    });
    const { peer } = makePeer();
    await expect(runPromptTurn(live, 'x', { peer, log })).rejects.toBeInstanceOf(AcpTurnFailed);
    expect(log).toHaveBeenCalled();
  });

  it('cancellation returns cancelled, interrupts, denies pending asks, drains queued updates', async () => {
    let release!: () => void;
    const { live, interrupt } = makeLive(async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: 'a' } } as OutputEvent;
      await new Promise<void>((r) => { release = r; });
      yield { type: 'chunk', chunk: { type: 'content', content: 'late' } } as OutputEvent;
      throw new Error('interrupted');
    });
    const cancelAll = vi.fn();
    live.gate = { canUseTool: vi.fn(), cancelAll } as unknown as LiveSession['gate'];
    const { peer, sent } = makePeer();
    const p = runPromptTurn(live, 'x', { peer, log: () => {} });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    cancelTurn(live, () => {});
    expect(live.translator.cancelled).toBe(true);
    expect(cancelAll).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledTimes(1);
    release();
    await expect(p).resolves.toBe('cancelled');
    expect(sent).toContainEqual({ sessionId: 's1', update: chunk('late') });
  });

  it('cancellation of a stream that never ends resolves after the grace period', async () => {
    const { live } = makeLive(async function* () {
      await new Promise<void>(() => {});
      yield { type: 'done' } as OutputEvent;
    });
    const { peer } = makePeer();
    const p = runPromptTurn(live, 'x', { peer, log: () => {}, cancelGraceMs: 10 });
    await new Promise((r) => setImmediate(r));
    cancelTurn(live, () => {});
    await expect(p).resolves.toBe('cancelled');
  });

  it('cancel on an idle session is a no-op', () => {
    const { live, interrupt } = makeLive(async function* () { /* empty */ });
    cancelTurn(live, () => {});
    expect(interrupt).not.toHaveBeenCalled();
  });
});

describe('makeEmitToolCall', () => {
  it('sends a pending start once, then converts an in_progress repeat into an update', async () => {
    const { live } = makeLive(async function* () { /* empty */ });
    const { peer, sent } = makePeer();
    const emit = makeEmitToolCall(live, peer);
    const start = { sessionUpdate: 'tool_call' as const, toolCallId: 't1', title: 'bash', name: 'bash', status: 'pending' as const };
    await emit(start);
    await emit(start);
    await emit({ ...start, status: 'in_progress' });
    await emit({ ...start, status: 'in_progress' });
    expect(sent).toEqual([
      { sessionId: 's1', update: start },
      { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' } },
    ]);
    expect(live.translator.tools.get('t1')?.announced).toBe(true);
  });

  it('closes a gate-owned card once with its content and never regresses a terminal card (D9)', async () => {
    const { live } = makeLive(async function* () { /* empty */ });
    const { peer, sent } = makePeer();
    const emit = makeEmitToolCall(live, peer);
    const start = { sessionUpdate: 'tool_call' as const, toolCallId: 'child-1-x', title: '[subagent] bash', name: 'bash', status: 'pending' as const };
    const content = [{ type: 'content' as const, content: { type: 'text' as const, text: 'Permission denied: rejected' } }];
    await emit(start);
    await emit({ ...start, status: 'failed', content });
    await emit({ ...start, status: 'in_progress' });
    await emit({ ...start, status: 'completed', content });
    expect(sent).toEqual([
      { sessionId: 's1', update: start },
      { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'child-1-x', status: 'failed', content } },
    ]);
  });
});

describe('runPromptTurn child card closing (D9)', () => {
  it('awaits gate.endTurn after the stream and before the final updates', async () => {
    const order: string[] = [];
    const { live } = makeLive(async function* () { yield { type: 'done', metadata: {} } as OutputEvent; });
    live.gate = { canUseTool: vi.fn() as never, cancelAll: vi.fn(), endTurn: vi.fn(async () => {
      expect(live.active?.ending).toBe(true);
      order.push('endTurn');
    }) };
    mFinish.mockImplementationOnce(() => { order.push('finish'); return { updates: [], stopReason: 'end_turn' }; });
    const { peer } = makePeer();
    expect(await runPromptTurn(live, 'x', { peer, log: () => {} })).toBe('end_turn');
    expect(order).toEqual(['endTurn', 'finish']);
  });
});
