/**
 * Integration test for mid-session date rollover in the system payload.
 *
 * The unit tests in `query/date-rollover.test.ts` cover the pure rewrite. This
 * file covers the seam that actually carried the defect: `userSystem` is
 * assembled once per `provider.query()`, and `composeSystem()` re-reads that
 * frozen string every turn — so before the fix, a session resident across local
 * midnight kept sending yesterday's `- Date:` line for the rest of its life.
 *
 * Asserted at the `messages.create` boundary (mirrors
 * `plan-mode-system-payload.test.ts`) — the closest observable point to what
 * the model actually sees. Only `Date` is faked; timers stay real so the
 * streaming machinery is untouched. The two instants are 48h apart so the local
 * date differs in EVERY host timezone, keeping the assertion valid on the
 * ubuntu/macos/windows CI legs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function* twoTurns(): AsyncIterable<{ content: string }> {
  yield { content: 'first' };
  yield { content: 'second' };
}

function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function extractSystemText(systemArg: unknown): string {
  if (typeof systemArg === 'string') return systemArg;
  if (!Array.isArray(systemArg)) return '';
  return (systemArg as ContentBlockParam[])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

function systemTextOfCall(i: number): string {
  const call = messagesCreateMock.mock.calls[i];
  return extractSystemText((call?.[0] as { system?: unknown } | undefined)?.system);
}

function dateLineOf(systemText: string): string | undefined {
  return systemText.split('\n').find((l) => l.startsWith('- Date: '));
}

/** Advance the fake clock to `at` after the Nth `messages.create` call. */
function rollClockAfterFirstCall(at: Date | null): void {
  let calls = 0;
  messagesCreateMock.mockImplementation(() => {
    calls += 1;
    if (calls === 1 && at !== null) vi.setSystemTime(at);
    return fromArray(makeTextStream('ok'));
  });
}

async function drain(query: AsyncIterable<unknown>): Promise<void> {
  for await (const _ev of query) {
    void _ev;
  }
}

function runTwoTurns(): AsyncIterable<unknown> {
  const provider = new AnthropicDirectProvider();
  return provider.query({
    prompt: twoTurns(),
    config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
  }) as AsyncIterable<unknown>;
}

const DAY_ONE = new Date('2026-07-30T12:00:00Z');
const DAY_THREE = new Date('2026-08-01T12:00:00Z'); // +48h: a different local date everywhere

describe('AnthropicDirectQuery — mid-session date rollover', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_ONE);
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
  });

  afterEach(() => {
    vi.useRealTimers();
    __setAnthropicClientFactory(null);
  });

  it('re-renders the Date line on the turn after the local day changes', async () => {
    rollClockAfterFirstCall(DAY_THREE);
    await drain(runTwoTurns());

    expect(messagesCreateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const first = dateLineOf(systemTextOfCall(0));
    const second = dateLineOf(systemTextOfCall(1));

    expect(first).toMatch(/^- Date: \w+, \d{4}-\d{2}-\d{2} \(.+\)$/);
    expect(second).toMatch(/^- Date: \w+, \d{4}-\d{2}-\d{2} \(.+\)$/);
    expect(second).not.toBe(first);
  });

  it('changes ONLY the Date line — the rest of the system payload is byte-identical', async () => {
    rollClockAfterFirstCall(DAY_THREE);
    await drain(runTwoTurns());

    const a = systemTextOfCall(0).split('\n');
    const b = systemTextOfCall(1).split('\n');
    expect(b).toHaveLength(a.length);
    const differing = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
    expect(differing).toHaveLength(1);
    expect(a[differing[0] as number]).toMatch(/^- Date: /);
  });

  // Cache economics: PR #268 froze the date to keep the system block stable
  // across turns. That property must survive the fix — same-day turns stay
  // byte-identical, so the prompt-cache breakpoint is busted at most once per
  // midnight crossing rather than once per turn.
  it('leaves the system payload untouched across turns within the same day', async () => {
    rollClockAfterFirstCall(null);
    await drain(runTwoTurns());

    expect(messagesCreateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(systemTextOfCall(1)).toBe(systemTextOfCall(0));
  });
});
