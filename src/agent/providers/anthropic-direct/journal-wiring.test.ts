/**
 * Integration: the anthropic-direct loop mirrors its message array into the
 * message journal at every commit point (docs/message-journal.md) — tool
 * rounds carry the FULL tool_result, compaction / rewind emit a truncate, and
 * `resumeMessages` seeds the first request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import type {
  JournalMarkLabel,
  JournalMessage,
  JournalTruncateReason,
  MessageJournal,
} from '../../journal/index.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { tool } from '../../tools/custom-tool.js';
import { fromArray, makeTextStream, makeToolUseStream } from './loop.test-helpers.js';
import { createSessionState } from './query/session-state.js';
import { compactQueryHistory, rewindQueryConversation } from './query-maintenance.js';
import { AbortCoordinator } from '../shared/abort-coordinator.js';
import type { RetryLayer } from './query/retry-layer.js';
import type { ToolDispatcher } from './tool-dispatcher.js';

vi.mock('../../awareness/workspace-source.js', () => ({
  gatherWorkspace: vi.fn(() => ({ branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null })),
}));

type Rec =
  | { kind: 'append'; index: number }
  | { kind: 'truncate'; length: number; reason?: JournalTruncateReason }
  | { kind: 'mark'; label: JournalMarkLabel };

class FakeJournal implements MessageJournal {
  records: Rec[] = [];
  arr: JournalMessage[] = [];
  get length(): number { return this.arr.length; }
  append(index: number, message: JournalMessage): void {
    expect(index).toBe(this.arr.length);
    this.arr.push(structuredClone(message));
    this.records.push({ kind: 'append', index });
  }
  truncate(length: number, reason?: JournalTruncateReason): void {
    this.arr.length = length;
    this.records.push({ kind: 'truncate', length, ...(reason ? { reason } : {}) });
  }
  mark(label: JournalMarkLabel): void { this.records.push({ kind: 'mark', label }); }
  forSubagent(): MessageJournal { return new FakeJournal(); }
  flush(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

const createMock = vi.fn();
class MockAnthropic {
  messages = { create: createMock };
}
async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}
async function drain(q: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of q) out.push(ev);
  return out;
}
const BASE_CONFIG = { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' } as const;

describe('anthropic-direct journal wiring — query loop', () => {
  beforeEach(() => {
    createMock.mockReset();
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
  });
  afterEach(() => { __setAnthropicClientFactory(null); });

  it('journals a tool round with the FULL tool_result content, then the final answer', async () => {
    const big = 'line of tool output\n'.repeat(1_500); // ~30 KB
    const dump = tool('dump_big', 'dump', z.object({}), async () => ({ content: big }));
    let call = 0;
    createMock.mockImplementation(() => {
      call += 1;
      return fromArray(call === 1 ? makeToolUseStream('toolu_big', 'dump_big', '{}') : makeTextStream('done'));
    });
    const journal = new FakeJournal();
    const provider = new AnthropicDirectProvider({ customTools: [dump] });
    await drain(provider.query({ prompt: singleInput('go'), config: { ...BASE_CONFIG, messageJournal: journal } }));

    expect(journal.arr.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(journal.arr[0]!.content).toEqual([{ type: 'text', text: 'go' }]);
    expect(journal.arr[1]!.content).toEqual([{ type: 'tool_use', id: 'toolu_big', name: 'dump_big', input: {} }]);
    const result = journal.arr[2]!.content[0]!;
    expect(result.type).toBe('tool_result');
    if (result.type !== 'tool_result') return;
    expect(result.toolUseId).toBe('toolu_big');
    const text = result.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    // Exactly what the model was sent in round 2 (no preview / truncation).
    const sent = (createMock.mock.calls[1]![0] as { messages: MessageParam[] }).messages[2]!;
    const sentBlock = (sent.content as Array<{ content: unknown }>)[0]!.content;
    const sentText = typeof sentBlock === 'string' ? sentBlock : (sentBlock as Array<{ text?: string }>).map((b) => b.text ?? '').join('');
    expect(text).toBe(sentText);
    expect(text).toContain(big.trimEnd());
    expect(journal.arr[3]!.content).toEqual([{ type: 'text', text: 'done' }]);
    // Append-only on the happy path: no truncates.
    expect(journal.records.every((r) => r.kind === 'append')).toBe(true);
  });

  it('seeds the first request (and the journal) from resumeMessages', async () => {
    createMock.mockImplementation(() => fromArray(makeTextStream('resumed ok')));
    const resumeMessages: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'earlier answer' }] },
    ];
    const journal = new FakeJournal();
    const provider = new AnthropicDirectProvider();
    await drain(provider.query({
      prompt: singleInput('next'),
      config: {
        ...BASE_CONFIG,
        resumeMessages,
        // Ignored when resumeMessages is present.
        resumeHistory: [{ user: 'LEGACY', assistant: 'LEGACY' }] as never,
        messageJournal: journal,
      },
    }));
    const sent = (createMock.mock.calls[0]![0] as { messages: MessageParam[] }).messages;
    expect(JSON.stringify(sent)).not.toContain('LEGACY');
    expect(sent[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'earlier question' }] });
    expect(sent[1]!.content).toEqual([
      { type: 'thinking', thinking: 't', signature: 's' },
      { type: 'text', text: 'earlier answer' },
    ]);
    expect(journal.arr.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

const dispatcher = {} as unknown as ToolDispatcher;
const u = (text: string): MessageParam => ({ role: 'user', content: text });
const a = (text: string): MessageParam => ({ role: 'assistant', content: text });

describe('anthropic-direct journal wiring — compaction and rewind', () => {
  const KEEP = 'AFK_COMPACT_KEEP_LAST_TURNS';
  beforeEach(() => { delete process.env[KEEP]; }); // audit-env-access: allow — test isolation
  afterEach(() => { delete process.env[KEEP]; }); // audit-env-access: allow — test isolation

  it('compaction emits truncate(compact) + the summary, then a compact mark', async () => {
    process.env[KEEP] = '1'; // audit-env-access: allow — test isolation
    const journal = new FakeJournal();
    const state = createSessionState({
      model: 'claude-sonnet-4-5', permissionMode: 'default', userSystem: null, toolDispatcher: dispatcher,
      initialMessages: [u('q1'), a('a1'), u('q2'), a('a2'), u('q3'), a('a3')],
      messageJournal: journal,
    });
    expect(journal.arr).toHaveLength(6);
    const retry = {
      authMode: 'api-key',
      client: { messages: { create: () => fromArray(makeTextStream('SUMMARY')) } },
    } as unknown as RetryLayer;
    const res = await compactQueryHistory({ state, abort: new AbortCoordinator(), retry, initSessionId: 's' });
    expect(res.compacted).toBe(true);
    const truncate = journal.records.find((r) => r.kind === 'truncate');
    expect(truncate).toMatchObject({ kind: 'truncate', reason: 'compact' });
    expect(journal.records.at(-1)).toEqual({ kind: 'mark', label: 'compact' });
    expect(journal.arr).toHaveLength(state.messages.length);
    expect(JSON.stringify(journal.arr)).toContain('SUMMARY');
  });

  it('microcompaction-only re-journals from the first cleared message so the fold shows the placeholder', async () => {
    vi.stubEnv('AFK_MICROCOMPACT_TOOL_RESULT_BYTES', '100');
    vi.stubEnv('AFK_MICROCOMPACT_KEEP_LAST', '0');
    try {
      const big = 'X'.repeat(5_000);
      const toolUse = (id: string): MessageParam => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'bash', input: {} }] });
      const toolResult = (id: string): MessageParam => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: big }] });
      const journal = new FakeJournal();
      const state = createSessionState({
        model: 'claude-sonnet-4-5', permissionMode: 'default', userSystem: null, toolDispatcher: dispatcher,
        initialMessages: [u('q1'), toolUse('t1'), toolResult('t1'), a('a1')],
        messageJournal: journal,
      });
      expect(JSON.stringify(journal.arr)).toContain(big);
      // Summarizer unavailable: the summary step fails, microcompaction still runs.
      const retry = {
        authMode: 'api-key',
        client: { messages: { create: () => { throw new Error('summarizer down'); } } },
      } as unknown as RetryLayer;
      const res = await compactQueryHistory({ state, abort: new AbortCoordinator(), retry, initSessionId: 's' });
      expect(res.compacted).toBe(false);
      expect(res.microcompaction?.blocksCleared).toBeGreaterThan(0);

      const truncate = journal.records.find((r) => r.kind === 'truncate');
      expect(truncate).toEqual({ kind: 'truncate', length: 2, reason: 'compact' });
      // The fold now matches what the model will be sent: no full result left.
      expect(journal.arr).toHaveLength(state.messages.length);
      expect(JSON.stringify(journal.arr)).not.toContain(big);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rewind emits truncate(rewind) at the divergence and a rewind mark', () => {
    const journal = new FakeJournal();
    const state = createSessionState({
      model: 'claude-test', permissionMode: 'default', userSystem: null, toolDispatcher: dispatcher,
      initialMessages: [u('q1'), a('a1'), u('q2'), a('a2')],
      messageJournal: journal,
    });
    const res = rewindQueryConversation(state, new AbortCoordinator(), 2);
    expect(res.rewound).toBe(true);
    expect(journal.records.slice(4)).toEqual([
      { kind: 'truncate', length: 2, reason: 'rewind' },
      { kind: 'mark', label: 'rewind' },
    ]);
    expect(journal.arr).toHaveLength(2);
  });
});
