/**
 * Test harness helpers for the openai-compatible provider in conformance tests.
 *
 * Uses the `__setOpenAIClientFactory` injection point — the same pattern used
 * in openai-compatible/query.test.ts and query-journal.test.ts.
 *
 * @module conformance/__test-utils__/openai-harness
 */

import type OpenAI from 'openai';
import { vi } from 'vitest';
import {
  __setOpenAIClientFactory,
  OpenAICompatibleQuery,
  type OpenAIClientFactory,
} from '../../openai-compatible/query.js';
import type { OpenAIChunk } from '../../openai-compatible/translate.js';
import type { ProviderEvent, ProviderUserTurn } from '../../../provider.js';

export type { OpenAIChunk };
export { __setOpenAIClientFactory };

// ---------------------------------------------------------------------------
// Stream-event helpers — OpenAI chunk shapes
// ---------------------------------------------------------------------------

/** Minimal text-only OpenAI chunk stream, stop `stop`. */
export function makeOpenAITextChunks(text: string): OpenAIChunk[] {
  return [
    { choices: [{ delta: { content: text } }] } as OpenAIChunk,
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as OpenAIChunk,
  ];
}

/** Minimal tool-use OpenAI chunk stream, stop `tool_calls`. */
export function makeOpenAIToolUseChunks(
  callId: string,
  toolName: string,
  argsJson: string,
): OpenAIChunk[] {
  return [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: callId,
            type: 'function',
            function: { name: toolName, arguments: argsJson },
          }],
        },
      }],
    } as OpenAIChunk,
    {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as OpenAIChunk,
  ];
}

// ---------------------------------------------------------------------------
// Mock OpenAI client builder
// ---------------------------------------------------------------------------

export type OpenAIScript =
  | OpenAIChunk[]
  | (() => AsyncIterable<OpenAIChunk>)
  | Error;

/** Build a mock OpenAI client whose `chat.completions.create` plays back scripts in order. */
export function makeOpenAIClient(scripts: OpenAIScript[]): {
  factory: OpenAIClientFactory;
  callCount: () => number;
} {
  let idx = 0;
  let callCount = 0;

  const factory: OpenAIClientFactory = () => {
    const create = vi.fn(
      async (args: { stream?: boolean }, options?: { signal?: AbortSignal }) => {
        callCount++;
        const script = scripts[idx++];
        if (!script) throw new Error('OpenAIHarness: no more scripted turns');

        if (script instanceof Error) throw script;

        if (!args.stream) throw new Error('OpenAIHarness: mock only supports streaming');

        const signal = options?.signal;

        if (typeof script === 'function') {
          return script();
        }

        const chunks = script;
        return (async function* () {
          for (const c of chunks) {
            if (signal?.aborted) {
              const e = new Error('aborted');
              e.name = 'AbortError';
              throw e;
            }
            yield c;
          }
        })();
      },
    );

    return {
      chat: { completions: { create } },
    } as unknown as OpenAI;
  };

  return { factory, callCount: () => callCount };
}

// ---------------------------------------------------------------------------
// Query factory
// ---------------------------------------------------------------------------

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

/** Collect all ProviderEvents from an async iterable. */
export async function collectEvents(
  gen: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

export interface OpenAIHarnessOpts {
  /** Scripted responses in order. */
  scripts: OpenAIScript[];
  /** The user prompt to send. Defaults to 'hi'. */
  prompt?: string;
  /** Tool dispatcher (no-op by default). */
  toolDispatcher?: import('../../anthropic-direct/tool-dispatcher.js').ToolDispatcher;
  /** Base retry delay in ms. Pass 0 to skip sleep in retry tests. */
  retryBaseDelayMs?: number;
}

/**
 * Build an OpenAICompatibleQuery with a scripted mock client and run it to
 * completion, returning all emitted ProviderEvents.
 *
 * Installs the client factory BEFORE construction and restores `null` after
 * completion. Safe to call inside `beforeEach`/`afterEach` or inline.
 */
export async function runOpenAIScenario(
  opts: OpenAIHarnessOpts,
): Promise<{ events: ProviderEvent[]; callCount: number }> {
  const { factory, callCount } = makeOpenAIClient(opts.scripts);

  if (opts.retryBaseDelayMs !== undefined) {
    const { __setRetryBaseDelay } = await import('../../openai-compatible/query.js');
    __setRetryBaseDelay(opts.retryBaseDelayMs);
  }

  __setOpenAIClientFactory(factory);
  try {
    const noopDispatcher = { execute: async () => ({ content: 'ok' }) };
    const query = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-conf-test', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'conf-sid',
      promptStream: singleInput(opts.prompt ?? 'hi'),
      config: { model: 'gpt-4o-mini', apiKey: 'sk-conf-test' } as import('../../../../agent/types/config-types.js').AgentConfig,
      ...(opts.toolDispatcher ? { toolDispatcher: opts.toolDispatcher } : { toolDispatcher: noopDispatcher }),
    });
    const events = await collectEvents(query);
    return { events, callCount: callCount() };
  } finally {
    __setOpenAIClientFactory(null);
    if (opts.retryBaseDelayMs !== undefined) {
      const { __setRetryBaseDelay } = await import('../../openai-compatible/query.js');
      __setRetryBaseDelay(2_000); // restore default
    }
  }
}
