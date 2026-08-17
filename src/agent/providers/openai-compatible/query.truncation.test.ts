/**
 * Truncation-notice coverage for the openai-compatible turn loop (#952).
 *
 * The sibling anthropic-direct behaviour is pinned by
 * `anthropic-direct/loop.orphan.test.ts`; this file pins the same
 * operator-visible contract on the other provider, which reaches truncation
 * through entirely different machinery (a derived `finalizedToolCalls(state)`
 * view rather than a `TurnResult.toolUseBlocks` array).
 *
 * The behaviour under test had ZERO coverage before this file: no test in this
 * directory drove `finish_reason: 'length'` at all, which is how the notice
 * came to be deferred out of the original #952 change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import {
  __setOpenAIClientFactory,
  buildQueryFromConfig,
  type OpenAIClientFactory,
} from './query.js';
import type { OpenAIChunk } from './translate.js';

let pendingChunks: OpenAIChunk[] = [];

function installMockClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }) => {
            if (!args.stream) throw new Error('mock only supports streaming mode');
            const chunks = pendingChunks.slice();
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

function baseConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'gpt-4o-mini', apiKey: 'sk-test-key', ...over } as AgentConfig;
}

/** The turn's single terminal assistant.message (there must never be two). */
function assistantMessages(events: ProviderEvent[]): string[] {
  return events
    .filter((e): e is Extract<ProviderEvent, { type: 'assistant.message' }> =>
      e.type === 'assistant.message',
    )
    .map((e) => e.text);
}

beforeEach(() => {
  pendingChunks = [];
  installMockClient();
});

afterEach(() => {
  __setOpenAIClientFactory(null);
});

describe('openai-compatible truncation notice (#952)', () => {
  it('appends a notice to the partial text on finish_reason "length"', async () => {
    pendingChunks = [
      { choices: [{ delta: { content: 'a partial answer' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      },
    ];
    const events = await collect(buildQueryFromConfig(baseConfig(), singleInput('hi')));
    const messages = assistantMessages(events);

    // Exactly ONE assistant.message: last-wins consumers (non-streaming
    // sendMessage, subagent final-message capture) keep only the last, so a
    // second event would discard the model's real answer.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('a partial answer');
    expect(messages[0]).toContain('output-token limit');
    expect(messages[0]).toContain('finish_reason "length"');
    // Text-only truncation names no tool and points at the cap knob.
    expect(messages[0]).toContain('allow a longer reply');
    expect(messages[0]).not.toContain('NOT dispatched');
    // Partial answer must come FIRST — the notice is a suffix, not a headline.
    expect(messages[0]!.indexOf('a partial answer')).toBeLessThan(
      messages[0]!.indexOf('output-token limit'),
    );
  });

  it('names a tool call truncated mid-arguments as NOT dispatched', async () => {
    // A tool call that began streaming and was cut off by the cap. isToolCallStop
    // returns false for an explicit non-tool finish_reason, so this call is never
    // dispatched — the drop is correct but was previously silent. The model also
    // produced text here, which is the ONLY path the notice rides on (see the
    // textless guard below).
    pendingChunks = [
      { choices: [{ delta: { content: 'let me read that' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  function: { name: 'read_file', arguments: '{"file_pa' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 },
      },
    ];
    const events = await collect(buildQueryFromConfig(baseConfig(), singleInput('read it')));
    const messages = assistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('let me read that');
    expect(messages[0]).toContain('output-token limit');
    expect(messages[0]).toContain('read_file');
    expect(messages[0]).toContain('NOT dispatched');

    // The truncated call really did not run: no tool events were emitted.
    expect(events.some((e) => e.type === 'tool.start' || e.type === 'tool.end')).toBe(false);
  });

  // #960 REGRESSION GUARD — do not "fix" the assistant.message assertion.
  //
  // A truncated turn that produced NO text must yield an EMPTY
  // assistant.message. The emptiness is the signal: stream-consumer's
  // `if (event.text)` gate drops it, so `subagent/handle.ts` never sets
  // `finalMessage`, reaches its ZERO-OUTPUT branch, and THROWS — which is what
  // makes a zero-output child resolve `failed` instead of a false `succeeded`,
  // and what lets stream-cut-retry re-dispatch a read-only child that produced
  // nothing. Substituting the notice as the body here would set `finalMessage`
  // and hand the parent a SUCCESS whose entire content is the warning.
  //
  // Issue #970: the notice IS now emitted on the dedicated `notice` channel
  // alongside the empty assistant.message — so the operator sees the truncation
  // on live surfaces while the zero-output detection chain is unaffected. The
  // stream-consumer maps 'notice' → {type:'notice'}, NOT {type:'message'}.
  // Mirrors the anthropic-direct guard in loop.orphan.test.ts.
  it('emits an EMPTY assistant.message AND a notice when the cap cuts a turn before any text', async () => {
    pendingChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  function: { name: 'read_file', arguments: '{"file_pa' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 },
      },
    ];
    const events = await collect(buildQueryFromConfig(baseConfig(), singleInput('read it')));
    const messages = assistantMessages(events);

    // The assistant.message is still empty — the zero-output detection chain
    // must remain reachable via stream-consumer's `if (event.text)` gate.
    expect(messages).toEqual(['']);
    expect(messages[0]).not.toContain('output-token limit');
    expect(events.some((e) => e.type === 'tool.start' || e.type === 'tool.end')).toBe(false);

    // Issue #970: a notice IS emitted so the operator can see the truncation.
    const noticeEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'notice' }> => e.type === 'notice',
    );
    expect(noticeEvents).toHaveLength(1);
    expect(noticeEvents[0]!.kind).toBe('truncation');
    expect(noticeEvents[0]!.text).toContain('output-token limit');
  });

  it('classifies the turn as truncated on turn.completed (trace + closure signal)', async () => {
    pendingChunks = [
      { choices: [{ delta: { content: 'cut' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    ];
    const events = await collect(buildQueryFromConfig(baseConfig(), singleInput('hi')));
    const final = events.at(-1);
    expect(final?.type).toBe('turn.completed');
    if (final?.type === 'turn.completed') {
      // closure-reason.ts maps this to ClosureReason 'truncated'.
      expect(final.usage.stopReason).toBe('length');
    }
  });

  it('stays silent on a clean stop — no notice on a normal completion', async () => {
    pendingChunks = [
      { choices: [{ delta: { content: 'all done' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ];
    const events = await collect(buildQueryFromConfig(baseConfig(), singleInput('hi')));
    const messages = assistantMessages(events);
    expect(messages).toEqual(['all done']);
    expect(messages[0]).not.toContain('output-token limit');
  });
});
