/**
 * Regression test for the "ESC mid-turn → can't resume" bug.
 *
 * Repro: in the REPL the user hit ESC to stop a running turn. Afterward, plain
 * prompts were echoed but started NO agent turn, while slash commands still
 * worked. Root cause: `AnthropicDirectQuery`'s outer multi-turn generator
 * `return`ed on ANY aborted per-turn controller (`if (controller.signal.aborted)
 * return`). Because `interrupt()` and `close()` both abort the per-turn
 * controller and differ only in an un-inspected reason string, an ESC interrupt
 * was treated like a session close and permanently terminated the generator.
 * `AgentSession` reuses ONE `providerIterator` across turns, so once the
 * generator returned every later `sendMessageStream` got `{done:true}` and ran
 * no turn. Slash commands kept working because they never pull the iterator.
 *
 * The fix discriminates close (`state.closed`) from interrupt and, on interrupt,
 * emits a terminal event (if the turn produced none) then loops back for the
 * next prompt instead of returning — mirroring the OpenAI-compatible provider.
 *
 * These tests drive the REAL `AnthropicDirectQuery[Symbol.asyncIterator]`
 * generator (where the bug lived) via `provider.query()`, mocking the Anthropic
 * SDK's `messages.create`. A mock-provider test at the AgentSession layer would
 * NOT catch the bug.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';

// --- Mock SDK plumbing (mirrors query-auth-retry.test.ts) ---

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
}

// --- Helpers ---

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** A single-message prompt stream that completes after one turn. */
async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

/** A prompt stream we can push user turns to over the life of the test. */
function createPushStream<T>(): {
  push: (item: T) => void;
  close: () => void;
  iterable: AsyncIterable<T>;
} {
  const queue: T[] = [];
  let waiting: ((r: IteratorResult<T>) => void) | null = null;
  let closed = false;
  return {
    push(item: T): void {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: item, done: false });
      } else {
        queue.push(item);
      }
    },
    close(): void {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined as unknown as T, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            const head = queue.shift();
            if (head !== undefined) return Promise.resolve({ value: head, done: false });
            if (closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
            return new Promise<IteratorResult<T>>((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    },
  };
}

/** Minimal text-only stream that ends with stop_reason=end_turn. */
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

function makeAbortError(): Error {
  const e = new Error('Request was aborted.');
  e.name = 'AbortError';
  return e;
}

// --- Tests ---

describe('AnthropicDirectQuery — interrupt mid-turn then resume', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  it('keeps the session alive so the next message runs after a mid-turn interrupt', async () => {
    const prompts = createPushStream<{ content: string }>();

    // The mock needs to interrupt the in-flight query; the query is built after
    // the factory is installed, so reference it through a forward `let`.
    let queryRef: { interrupt(): Promise<void> } | null = null;
    let turnIdx = 0;

    messagesCreateMock.mockImplementation(() => {
      turnIdx += 1;
      if (turnIdx === 1) {
        // Simulate ESC mid-stream: interrupt the running turn, then let the
        // request abort (SDK throws AbortError). loop.ts catches the abort and
        // yields turn.completed; the OUTER generator must then loop back for the
        // next prompt rather than terminating the shared iterator.
        return (async function* (): AsyncGenerator<RawMessageStreamEvent> {
          await queryRef!.interrupt();
          throw makeAbortError();
        })();
      }
      // Turn 2: a normal text reply — the message that "wouldn't send" pre-fix.
      return fromArray(makeTextStream('resumed reply'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: prompts.iterable,
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });
    queryRef = query;

    const it = (query as AsyncIterable<ProviderEvent>)[Symbol.asyncIterator]();

    // session.init handshake.
    const init = await it.next();
    expect(init.done).toBe(false);
    expect((init.value as ProviderEvent).type).toBe('session.init');

    // Turn 1 — drive it; it self-interrupts mid-stream.
    prompts.push({ content: 'first' });
    let r = await it.next();
    while (!r.done && (r.value as ProviderEvent).type !== 'turn.completed') {
      r = await it.next();
    }
    // The aborted turn yields a terminal turn.completed AND the generator is
    // still alive (the bug terminated it here).
    expect(r.done).toBe(false);
    expect((r.value as ProviderEvent).type).toBe('turn.completed');

    // Turn 2 — the regression: before the fix the shared generator had already
    // returned, so pushing a new message produced nothing (no agent turn).
    prompts.push({ content: 'second' });
    let assistantText = '';
    let sawTurn2Completed = false;
    r = await it.next();
    while (!r.done) {
      const ev = r.value as ProviderEvent;
      if (ev.type === 'delta.text') assistantText += ev.text;
      if (ev.type === 'assistant.message') assistantText = ev.text;
      if (ev.type === 'turn.completed') {
        sawTurn2Completed = true;
        break;
      }
      r = await it.next();
    }

    expect(sawTurn2Completed).toBe(true);
    expect(assistantText).toContain('resumed reply');

    // A second mid-conversation model call confirms the turn actually ran.
    expect(turnIdx).toBe(2);

    prompts.close();
    await it.return?.();
  });

  it('emits exactly ONE terminal event on interrupt so the next turn is not wasted (the "poke to start" bug)', async () => {
    // Distinct from the test above: that one drains PAST the abort error to the
    // turn.completed, hiding the leftover-terminal bug. AgentSession's real
    // consumer (sendMessageStreamInternal) breaks on the FIRST terminal event
    // (`done` OR `error`, agent-session.ts). If the abort path yields BOTH an
    // `error` and a `turn.completed`, the consumer stops on the error and the
    // trailing turn.completed is stranded — the NEXT turn's first pull consumes
    // it as a no-op `done`, so the user's next message runs a full turn late.
    // That is exactly "I type a message after ESC, nothing happens, so I poke
    // '.' to make the turn start."
    const prompts = createPushStream<{ content: string }>();
    let queryRef: { interrupt(): Promise<void> } | null = null;
    let turnIdx = 0;

    messagesCreateMock.mockImplementation(() => {
      turnIdx += 1;
      if (turnIdx === 1) {
        return (async function* (): AsyncGenerator<RawMessageStreamEvent> {
          await queryRef!.interrupt();
          throw makeAbortError();
        })();
      }
      return fromArray(makeTextStream('resumed reply'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: prompts.iterable,
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });
    queryRef = query;
    const it = (query as AsyncIterable<ProviderEvent>)[Symbol.asyncIterator]();

    // session.init handshake.
    await it.next();

    // Turn 1 — drive until the FIRST terminal event, exactly as AgentSession does.
    prompts.push({ content: 'first' });
    const isTerminal = (t: string): boolean => t === 'turn.completed' || t === 'error';
    let r = await it.next();
    while (!r.done && !isTerminal((r.value as ProviderEvent).type)) {
      r = await it.next();
    }
    expect(r.done).toBe(false);
    // The aborted turn's FIRST (and only) terminal must be turn.completed — never
    // an `error` that strands a trailing turn.completed for the next turn to eat.
    expect((r.value as ProviderEvent).type).toBe('turn.completed');

    // Turn 2 — the real message must run THIS turn, not a turn late.
    prompts.push({ content: 'second' });
    let assistantText = '';
    r = await it.next();
    while (!r.done) {
      const ev = r.value as ProviderEvent;
      if (ev.type === 'delta.text') assistantText += ev.text;
      if (ev.type === 'turn.completed') break;
      r = await it.next();
    }
    // No wasted turn: the model was actually called again (turnIdx===2) and the
    // reply streamed. Pre-fix this failed — Turn 2 consumed the stranded
    // turn.completed as a no-op and turnIdx stayed 1.
    expect(assistantText).toContain('resumed reply');
    expect(turnIdx).toBe(2);

    prompts.close();
    await it.return?.();
  });

  it('a real (non-abort) error still terminates the generator with an error event', async () => {
    // Guards against over-correction: only interrupts keep the session alive.
    // A genuine error (no abort signal) must still surface as an `error` event
    // and end the generator — the catch path's non-abort branch is unchanged.
    messagesCreateMock.mockImplementation(() => {
      throw new Error('boom: upstream failure');
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('first'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    // `collect` runs the generator to completion — if a real error wrongly kept
    // the session alive, it would block on the next prompt and time out here.
    const events = await collect(query as AsyncIterable<ProviderEvent>);

    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
