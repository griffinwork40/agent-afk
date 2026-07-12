/**
 * OpenAI-compatible compaction tests: the message-representation ops and the
 * `compactOpenAIHistory` handler (bail paths + successful in-place splice),
 * driven by a stubbed summarizer so no network is touched.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  compactOpenAIHistory,
  isFreshUserTurn,
  openaiCompactionOps,
  type CompactOpenAIHistoryDeps,
} from './compact.js';
import { COMPACT_ACK_TEXT, COMPACT_SUMMARY_HEADER } from '../shared/compaction.js';
import type { OpenAIMessage } from './messages.js';

describe('openai isFreshUserTurn', () => {
  it('is true only for role:user', () => {
    expect(isFreshUserTurn({ role: 'user', content: 'hi' })).toBe(true);
    expect(isFreshUserTurn({ role: 'assistant', content: 'hi' })).toBe(false);
    expect(isFreshUserTurn({ role: 'tool', content: 'r', tool_call_id: 'c' })).toBe(false);
    expect(isFreshUserTurn({ role: 'system', content: 'sys' })).toBe(false);
  });
});

describe('openaiCompactionOps.renderMessage', () => {
  it('renders assistant tool_calls as [tool call: NAME args]', () => {
    const msg = {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'grep', arguments: '{"q":"foo"}' } }],
    } as unknown as OpenAIMessage;
    const rendered = openaiCompactionOps.renderMessage(msg);
    expect(rendered).toContain('[tool call: grep {"q":"foo"}]');
  });
  it('labels tool-result messages and flattens image parts', () => {
    expect(openaiCompactionOps.renderMessage({ role: 'tool', content: 'matched 3', tool_call_id: 'c' })).toContain(
      'Tool result:',
    );
    const vision: OpenAIMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:...' } },
      ],
    };
    const r = openaiCompactionOps.renderMessage(vision);
    expect(r).toContain('look');
    expect(r).toContain('[image]');
  });
});

/** History with `n` fresh user turns interleaved with assistant replies. */
function history(): OpenAIMessage[] {
  return [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ];
}

function deps(over: Partial<CompactOpenAIHistoryDeps> = {}): CompactOpenAIHistoryDeps {
  return {
    priorTurns: history(),
    summarize: async () => 'COMPRESSED',
    isClosed: false,
    isIdle: true,
    beginAbort: () => new AbortController(),
    clearAbort: () => {},
    ...over,
  };
}

describe('compactOpenAIHistory', () => {
  it('summarizes older turns and splices the preamble in place', async () => {
    const d = deps();
    const summarize = vi.fn(async () => 'COMPRESSED');
    const result = await compactOpenAIHistory({ ...d, summarize });
    expect(result.compacted).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    // keepLastN defaults to 2 → boundary at u2 (index 2). New history:
    // [user(summary), assistant(ack), u2, a2, u3]
    expect(d.priorTurns[0]?.role).toBe('user');
    expect(d.priorTurns[0]?.content).toContain(COMPACT_SUMMARY_HEADER);
    expect(d.priorTurns[0]?.content).toContain('COMPRESSED');
    expect(d.priorTurns[1]?.content).toBe(COMPACT_ACK_TEXT);
    expect(d.priorTurns[2]?.content).toBe('u2');
    expect(d.priorTurns).toHaveLength(5);
  });

  it('passes an abort signal to the summarizer', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await compactOpenAIHistory(
      deps({
        beginAbort: () => controller,
        summarize: async (_t, signal) => {
          seen = signal;
          return 'S';
        },
      }),
    );
    expect(seen).toBe(controller.signal);
  });

  it('bails session-closed', async () => {
    const d = deps({ isClosed: true });
    const before = [...d.priorTurns];
    const result = await compactOpenAIHistory(d);
    expect(result).toMatchObject({ compacted: false, reason: 'session-closed' });
    expect(d.priorTurns).toEqual(before);
  });

  it('bails turn-in-flight when not idle', async () => {
    const result = await compactOpenAIHistory(deps({ isIdle: false }));
    expect(result).toMatchObject({ compacted: false, reason: 'turn-in-flight' });
  });

  it('no-ops history-too-short on a short session (never calls summarize)', async () => {
    const summarize = vi.fn(async () => 'S');
    const result = await compactOpenAIHistory({
      ...deps({ priorTurns: [{ role: 'user', content: 'only one' }] }),
      summarize,
    });
    expect(result).toMatchObject({ compacted: false, reason: 'history-too-short' });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('refuses an empty summary (history untouched)', async () => {
    const d = deps({ summarize: async () => '  ' });
    const before = [...d.priorTurns];
    const result = await compactOpenAIHistory(d);
    expect(result).toMatchObject({ compacted: false, reason: 'empty-summary' });
    expect(d.priorTurns).toEqual(before);
  });

  it('releases the abort scope after completion', async () => {
    const clearAbort = vi.fn();
    await compactOpenAIHistory(deps({ clearAbort }));
    expect(clearAbort).toHaveBeenCalledTimes(1);
  });
});
