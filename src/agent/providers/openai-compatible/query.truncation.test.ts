/**
 * Truncation-notice coverage for the openai-compatible turn loop (#952, #971).
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
 *
 * Issue #971 adds a parallel describe block for the Responses wire so both
 * paths are covered: Chat Completions (`finish_reason: 'length'`) and Responses
 * (`response.incomplete` with `incomplete_details.reason: 'max_output_tokens'`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import {
  __setOpenAIClientFactory,
  buildQueryFromConfig,
  OpenAICompatibleQuery,
  type OpenAIClientFactory,
} from './query.js';
import type { OpenAIChunk } from './translate.js';
import type { ResponsesStreamEvent } from './responses-translate.js';
import type { OpenAIAuthResolution } from './auth.js';

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

// ─── Responses-wire mock (separate variable so it never clashes with pendingChunks) ───

let pendingResponseEvents: ResponsesStreamEvent[] = [];

function installResponsesMockClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      responses: {
        create: async (_args: { stream?: boolean }) => {
          const events = pendingResponseEvents.slice();
          return (async function* () {
            for (const e of events) yield e;
          })();
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

// ─────────────────────────────────────────────────────────────────────────────
// Responses-wire truncation tests (#971)
//
// Mirrors the Chat Completions block above but drives `response.incomplete`
// with `incomplete_details.reason: 'max_output_tokens'` through the real
// query.ts path. Key differences from Chat Completions:
//  - Mock exposes `responses.create` (not `chat.completions.create`)
//  - Events are ResponsesStreamEvent typed (not OpenAIChunk)
//  - Truncation sentinel: incomplete_details.reason "max_output_tokens"
//  - Pass `{ useResponsesApi: true }` to buildQueryFromConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('openai-compatible truncation notice — Responses wire (#971)', () => {
  beforeEach(() => {
    pendingResponseEvents = [];
    installResponsesMockClient();
  });

  // afterEach from the outer scope already calls __setOpenAIClientFactory(null).

  it('appends a notice to the partial text on response.incomplete', async () => {
    // A text delta followed by response.incomplete — the canonical truncation
    // scenario on the Responses wire. The partial text must be preserved and
    // the wire-accurate sentinel label must appear in the notice.
    pendingResponseEvents = [
      { type: 'response.output_text.delta', delta: 'a partial answer' },
      {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        },
      },
    ];
    const events = await collect(
      buildQueryFromConfig(baseConfig(), singleInput('hi'), { useResponsesApi: true }),
    );
    const messages = assistantMessages(events);

    // Exactly ONE assistant.message (same invariant as Chat Completions path).
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('a partial answer');
    expect(messages[0]).toContain('output-token limit');
    // Wire-accurate sentinel — matches `sentinelLabel('max_output_tokens')` in truncation.ts.
    expect(messages[0]).toContain('incomplete_details.reason "max_output_tokens"');
    // Text-only truncation: no dropped tool, points at the cap knob.
    expect(messages[0]).toContain('allow a longer reply');
    expect(messages[0]).not.toContain('NOT dispatched');
    // Partial answer must come FIRST — notice is a suffix, not a headline.
    expect(messages[0]!.indexOf('a partial answer')).toBeLessThan(
      messages[0]!.indexOf('output-token limit'),
    );
  });

  it('names a truncated tool call as NOT dispatched', async () => {
    // Text delta + a function_call that began streaming but was cut mid-arguments.
    // The Responses wire announces a function_call item via response.output_item.added
    // and then streams argument fragments via response.function_call_arguments.delta.
    // When response.incomplete arrives the call is silently dropped — this test
    // asserts that drop is now visible in the notice.
    pendingResponseEvents = [
      { type: 'response.output_text.delta', delta: 'let me read that' },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'item_abc', call_id: 'call_abc', name: 'read_file', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"file_pa',
      },
      {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 10, output_tokens: 9, total_tokens: 19 },
        },
      },
    ];
    const events = await collect(
      buildQueryFromConfig(baseConfig(), singleInput('read it'), { useResponsesApi: true }),
    );
    const messages = assistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('let me read that');
    expect(messages[0]).toContain('output-token limit');
    expect(messages[0]).toContain('read_file');
    expect(messages[0]).toContain('NOT dispatched');

    // The truncated call really did not run: no tool events were emitted.
    expect(events.some((e) => e.type === 'tool.start' || e.type === 'tool.end')).toBe(false);
  });

  // Zero-output invariant guard — mirrors the Chat Completions version above.
  // A textless Responses truncation must yield an EMPTY assistant.message so
  // the zero-output detection chain in subagent/handle.ts remains reachable.
  it('emits EMPTY assistant.message AND a notice when the cap cuts before any text', async () => {
    // Only a function_call output item + response.incomplete — no text delta.
    pendingResponseEvents = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'item_abc', call_id: 'call_abc', name: 'read_file', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"file_pa',
      },
      {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 10, output_tokens: 9, total_tokens: 19 },
        },
      },
    ];
    const events = await collect(
      buildQueryFromConfig(baseConfig(), singleInput('read it'), { useResponsesApi: true }),
    );
    const messages = assistantMessages(events);

    // Empty assistant.message so zero-output chain is reachable (#960 invariant).
    expect(messages).toEqual(['']);
    expect(messages[0]).not.toContain('output-token limit');
    expect(events.some((e) => e.type === 'tool.start' || e.type === 'tool.end')).toBe(false);

    // A notice IS emitted separately so the operator sees the truncation (#970).
    const noticeEvents = events.filter(
      (e): e is Extract<ProviderEvent, { type: 'notice' }> => e.type === 'notice',
    );
    expect(noticeEvents).toHaveLength(1);
    expect(noticeEvents[0]!.kind).toBe('truncation');
    expect(noticeEvents[0]!.text).toContain('output-token limit');
  });

  it('classifies the turn as truncated on turn.completed (stopReason: max_output_tokens)', async () => {
    // turn.completed must carry stopReason: 'max_output_tokens' so
    // closure-reason.ts classifies the session as 'truncated'.
    pendingResponseEvents = [
      { type: 'response.output_text.delta', delta: 'cut' },
      {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        },
      },
    ];
    const events = await collect(
      buildQueryFromConfig(baseConfig(), singleInput('hi'), { useResponsesApi: true }),
    );
    const final = events.at(-1);
    expect(final?.type).toBe('turn.completed');
    if (final?.type === 'turn.completed') {
      expect(final.usage.stopReason).toBe('max_output_tokens');
    }
  });

  it('stays silent on a clean response.completed — no truncation notice', async () => {
    // A normal completed response must NOT produce any truncation artefacts.
    pendingResponseEvents = [
      { type: 'response.output_text.delta', delta: 'all done' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      },
    ];
    const events = await collect(
      buildQueryFromConfig(baseConfig(), singleInput('hi'), { useResponsesApi: true }),
    );
    const messages = assistantMessages(events);
    expect(messages).toEqual(['all done']);
    expect(messages[0]).not.toContain('output-token limit');
    // No notice events emitted.
    expect(events.some((e) => e.type === 'notice')).toBe(false);
  });

  it('chatgpt-oauth: canIncreaseOutputLimit: false — notice says "Continue in a follow-up turn"', async () => {
    // When auth.source is 'chatgpt-oauth' and stopReason is 'max_output_tokens',
    // query.ts sets canIncreaseOutputLimit: false because the ChatGPT backend
    // rejects every output-cap parameter. The notice must therefore guide the
    // operator to continue in a follow-up turn rather than to raise the cap.
    //
    // We construct OpenAICompatibleQuery directly (not via buildQueryFromConfig)
    // to control auth.source without triggering env-based auth resolution.
    pendingResponseEvents = [
      { type: 'response.output_text.delta', delta: 'partial answer' },
      {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        },
      },
    ];
    installResponsesMockClient();

    const auth: OpenAIAuthResolution = { apiKey: 'access-token-xyz', source: 'chatgpt-oauth', accountId: 'acct_z' };
    const query = new OpenAICompatibleQuery({
      auth,
      model: 'gpt-5',
      synthesizedSessionId: 'sess-truncation-oauth',
      promptStream: singleInput('hi'),
      config: baseConfig(),
      // chatgpt-oauth selects Responses automatically — no explicit useResponsesApi needed
    });
    const events = await collect(query);
    const messages = assistantMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('partial answer');
    expect(messages[0]).toContain('output-token limit');
    expect(messages[0]).toContain('incomplete_details.reason "max_output_tokens"');
    // canIncreaseOutputLimit: false path — must NOT mention the cap flag.
    expect(messages[0]).toContain('Continue in a follow-up turn');
    expect(messages[0]).not.toContain('Raise --max-output-tokens');
  });
});
