import { describe, it, expect } from 'vitest';
import type { JournalMessage } from '../../journal/index.js';
import type { OpenAIMessage } from './messages.js';
import { INTERRUPTED_TOOL_RESULT, openAIJournalAdapter as adapter } from './journal-adapter.js';

const asMsg = (m: Record<string, unknown>): OpenAIMessage => m as unknown as OpenAIMessage;

describe('openAIJournalAdapter.toJournal', () => {
  it('maps assistant tool_calls, reasoning, and null content', () => {
    const j = adapter.toJournal(asMsg({
      role: 'assistant',
      content: null,
      reasoning_content: 'think',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"msg":"hi"}' } },
        { id: 'c2', type: 'function', function: { name: 'bad', arguments: '{not json' } },
      ],
    }));
    expect(j).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'think', origin: 'openai-compatible' },
        { type: 'tool_use', id: 'c1', name: 'echo', input: { msg: 'hi' } },
        { type: 'tool_use', id: 'c2', name: 'bad', input: { _raw: '{not json' } },
      ],
    });
  });

  it('maps a tool message to one tool_result, flagging [error] without altering content', () => {
    expect(adapter.toJournal({ role: 'tool', tool_call_id: 'c1', content: '[error] boom' })).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'c1', isError: true, content: [{ type: 'text', text: '[error] boom' }] }],
    });
  });

  it('maps image parts to base64 image blocks and drops system', () => {
    const j = adapter.toJournal({
      role: 'user',
      content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
    });
    expect(j?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'QUJD' } },
    ]);
    expect(adapter.toJournal({ role: 'system', content: 'sys' })).toBeNull();
  });
});

describe('openAIJournalAdapter.fromJournalMessages', () => {
  it('round-trips the provider’s own tool-round array', () => {
    const native: OpenAIMessage[] = [
      { role: 'user', content: 'go' },
      asMsg({
        role: 'assistant',
        content: 'calling',
        reasoning_content: 'r',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"msg":"hi"}' } },
          { id: 'c2', type: 'function', function: { name: 'bad', arguments: '{oops' } },
        ],
      }),
      { role: 'tool', tool_call_id: 'c1', content: 'echoed' },
      { role: 'tool', tool_call_id: 'c2', content: '[error] parse failed' },
      { role: 'user', content: [{ type: 'text', text: 'img' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
      { role: 'assistant', content: 'done' },
    ];
    const journal = native.map((m) => adapter.toJournal(m)).filter((m): m is JournalMessage => m !== null);
    expect(adapter.fromJournalMessages(journal)).toEqual(native);
  });

  it('splits an Anthropic-written batched tool_result message into ordered tool messages', () => {
    const anthropic: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 'sig' },
          { type: 'redacted_thinking', data: 'x' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } },
          { type: 'tool_use', id: 'toolu_2', name: 'read', input: { path: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_1', content: [{ type: 'text', text: 'A' }] },
          { type: 'tool_result', toolUseId: 'toolu_2', isError: true, content: [{ type: 'text', text: 'nope' }, { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'QUJD' } }] },
          { type: 'text', text: 'queued note' },
        ],
      },
    ];
    expect(adapter.fromJournalMessages(anthropic)).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 't',
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
          { id: 'toolu_2', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'A' },
      { role: 'tool', tool_call_id: 'toolu_2', content: '[error] nope' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image output from tool calls (referenced above):' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          { type: 'text', text: 'queued note' },
        ],
      },
    ]);
  });
});

describe('openAIJournalAdapter.fromJournalMessages — unanswered tool calls', () => {
  const call = (id: string) => ({ type: 'tool_use' as const, id, name: 'read', input: {} });
  const result = (id: string) => ({ type: 'tool_result' as const, toolUseId: id, content: [{ type: 'text' as const, text: `r-${id}` }] });

  it('answers a trailing tool call with no recorded result with a synthetic error', () => {
    const out = adapter.fromJournalMessages([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [call('c1')] },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: INTERRUPTED_TOOL_RESULT });
    expect(INTERRUPTED_TOOL_RESULT.startsWith('[error] ')).toBe(true);
  });

  it('inserts the synthetic result after the call\'s existing tool messages, before any user message', () => {
    const out = adapter.fromJournalMessages([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [call('c1'), call('c2')] },
      { role: 'user', content: [result('c1'), { type: 'text', text: 'note' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'go' },
      expect.objectContaining({ role: 'assistant' }),
      { role: 'tool', tool_call_id: 'c1', content: 'r-c1' },
      { role: 'tool', tool_call_id: 'c2', content: INTERRUPTED_TOOL_RESULT },
      { role: 'user', content: 'note' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('leaves fully answered tool rounds untouched', () => {
    const journal: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [call('c1')] },
      { role: 'user', content: [result('c1')] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const out = adapter.fromJournalMessages(journal);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(out.some((m) => m.content === INTERRUPTED_TOOL_RESULT)).toBe(false);
  });
});

