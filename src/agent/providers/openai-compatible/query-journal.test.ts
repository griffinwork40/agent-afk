/**
 * Message-journal wiring for OpenAICompatibleQuery: the journal receives the
 * FULL tool round (assistant tool_use + full tool_result), and a
 * `resumeMessages` seed replays tool calls/results on the wire.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { JournalMessage, JournalTruncateReason, MessageJournal } from '../../journal/index.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { createHookRegistry } from '../../hooks.js';
import type { ToolHandler } from '../../tools/types.js';
import { __setOpenAIClientFactory, OpenAICompatibleQuery, type OpenAIClientFactory } from './query.js';
import type { OpenAIChunk } from './translate.js';

class FakeJournal implements MessageJournal {
  arr: JournalMessage[] = [];
  truncates: Array<{ length: number; reason?: JournalTruncateReason }> = [];
  get length(): number { return this.arr.length; }
  append(index: number, message: JournalMessage): void {
    expect(index).toBe(this.arr.length);
    this.arr.push(message);
  }
  truncate(length: number, reason?: JournalTruncateReason): void {
    this.arr.length = length;
    this.truncates.push({ length, ...(reason ? { reason } : {}) });
  }
  mark(): void {}
  forSubagent(): MessageJournal { return new FakeJournal(); }
  flush(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

let scripted: OpenAIChunk[][] = [];
let createCalls: Array<{ messages: unknown[] }> = [];

beforeEach(() => {
  scripted = [];
  createCalls = [];
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { messages: unknown[] }) => {
            createCalls.push({ messages: structuredClone(args.messages) });
            const chunks = scripted.shift();
            if (!chunks) throw new Error('no scripted turn');
            return (async function* () { for (const c of chunks) yield c; })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
});
afterEach(() => __setOpenAIClientFactory(null));

const BIG = 'x'.repeat(50_000);
const textTurn = (text: string): OpenAIChunk[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
];
const toolTurn: OpenAIChunk[] = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'big', arguments: '{"n":1}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
];

function dispatcher(): SessionToolDispatcher {
  const big: ToolHandler = async () => ({ content: BIG });
  return new SessionToolDispatcher({
    handlers: new Map([['big', big]]),
    schemas: [{ name: 'big', description: 'big output', input_schema: { type: 'object' } }],
    hookRegistry: createHookRegistry(),
  });
}

async function run(config: Partial<AgentConfig>, prompt: string, withTools = false, baseURL?: string): Promise<ProviderEvent[]> {
  async function* input(): AsyncIterable<ProviderUserTurn> { yield { content: prompt }; }
  const q = new OpenAICompatibleQuery({
    auth: { apiKey: 'sk-test', source: 'config', last4: 'test' },
    model: 'gpt-4o-mini',
    synthesizedSessionId: 'sid-j',
    promptStream: input(),
    config: { model: 'gpt-4o-mini', apiKey: 'sk-test', ...config } as AgentConfig,
    ...(withTools ? { toolDispatcher: dispatcher() } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
  });
  const events: ProviderEvent[] = [];
  for await (const ev of q) events.push(ev);
  return events;
}

describe('OpenAICompatibleQuery message journal', () => {
  it.each([
    ['reasoning', 'https://api.deepseek.com/v1', 'reasoning_content'],
    ['reasoning_content', 'https://api.cerebras.ai/v1', 'reasoning'],
    ['reasoning', 'https://api.cerebras.ai/v1', 'reasoning'],
    ['reasoning_content', 'https://api.deepseek.com', 'reasoning_content'],
    ['reasoning', undefined, null],
    ['reasoning_content', 'https://strict.example/v1', null],
    ['reasoning', 'https://api.deepseek.com.evil.example/v1', null],
  ] as const)('replays %s at %s using only destination field %s', async (sourceField, baseURL, targetField) => {
    const resumeMessages: JournalMessage[] = [
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'source thought', origin: `openai-compatible:${sourceField}` },
        { type: 'tool_use', id: 'old', name: 'big', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'old', content: [{ type: 'text', text: 'old result' }] }] },
      { role: 'assistant', content: [{ type: 'text', text: 'no reasoning' }] },
    ];
    const journal = new FakeJournal();
    journal.arr = [...resumeMessages];
    const liveField = targetField ?? 'reasoning';
    scripted = [
      [{ choices: [{ delta: { [liveField]: 'destination thought' } }] }, ...toolTurn],
      textTurn('done'),
    ];
    const events = await run({ messageJournal: journal, resumeMessages }, 'next', true, baseURL);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    const first = createCalls[0]!.messages as Array<Record<string, unknown>>;
    const imported = first.find((m) => m['role'] === 'assistant')!;
    expect(imported['tool_calls']).toMatchObject([{ id: 'old' }]);
    expect(first.find((m) => m['role'] === 'tool')?.['content']).toBe('old result');
    for (const field of ['reasoning', 'reasoning_content']) {
      if (field === targetField) expect(imported[field]).toBe('source thought');
      else expect(imported).not.toHaveProperty(field);
    }
    if (targetField === 'reasoning_content') {
      expect(first.find((m) => m['content'] === 'no reasoning')).toHaveProperty('reasoning_content', '');
    }
    const second = createCalls[1]!.messages as Array<Record<string, unknown>>;
    expect(second.find((m) => m[liveField] === 'destination thought')).toBeDefined();
    // Replaying for a different wire must not destroy source thinking provenance.
    expect(journal.arr.slice(0, resumeMessages.length)).toEqual(resumeMessages);
    expect(journal.truncates).toEqual([]);
  });

  it('journals the full tool round and final answer', async () => {
    scripted = [toolTurn, textTurn('done')];
    const journal = new FakeJournal();
    await run({ messageJournal: journal }, 'go', true);
    expect(journal.arr.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(journal.arr[1]!.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'big', input: { n: 1 } }]);
    const result = journal.arr[2]!.content[0];
    expect(result?.type).toBe('tool_result');
    if (result?.type === 'tool_result') {
      expect(result.toolUseId).toBe('call_1');
      expect(result.content).toEqual([{ type: 'text', text: BIG }]);
    }
    expect(journal.arr[3]!.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(journal.truncates).toEqual([]);
  });

  it('resumes tool calls and results from resumeMessages, ignoring resumeHistory', async () => {
    scripted = [textTurn('ok')];
    const resumeMessages: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'read', input: { p: 'a' } },
        { type: 'tool_use', id: 't2', name: 'read', input: { p: 'b' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'A' }] },
        { type: 'tool_result', toolUseId: 't2', content: [{ type: 'text', text: 'B' }] },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'read both' }] },
    ];
    const journal = new FakeJournal();
    journal.arr = [...resumeMessages];
    await run({
      messageJournal: journal,
      resumeMessages,
      resumeHistory: [{ user: 'LEGACY', assistant: 'LEGACY' }] as AgentConfig['resumeHistory'],
    }, 'next');
    const sent = createCalls[0]!.messages as Array<Record<string, unknown>>;
    expect(sent.some((m) => m['content'] === 'LEGACY')).toBe(false);
    expect(sent.map((m) => m['role'])).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'user']);
    expect(sent[1]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
        { id: 't2', type: 'function', function: { name: 'read', arguments: '{"p":"b"}' } },
      ],
    });
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'A' });
    expect(sent[3]).toEqual({ role: 'tool', tool_call_id: 't2', content: 'B' });
    // With provenance (#2464): the batched user message is adopted, so seed()
    // writes nothing. Journal stays in its original Anthropic shape (4 msgs)
    // and the new turn appends its user message and the reply → 6 total.
    expect(journal.truncates).toEqual([]);
    expect(journal.arr).toHaveLength(6);
  });

  it('resumes an OpenAI-written journal without a resync', async () => {
    scripted = [toolTurn, textTurn('first'), textTurn('second')];
    const journal = new FakeJournal();
    await run({ messageJournal: journal }, 'go', true);
    const resumeMessages = [...journal.arr];
    await run({ messageJournal: journal, resumeMessages }, 'again');
    expect(journal.truncates).toEqual([]);
    expect(journal.arr).toHaveLength(resumeMessages.length + 2);
    const sent = createCalls[2]!.messages as Array<Record<string, unknown>>;
    expect(sent.map((m) => m['role'])).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: BIG });
  });
});
