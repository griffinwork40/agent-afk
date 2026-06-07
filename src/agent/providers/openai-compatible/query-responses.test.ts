/**
 * Query-level integration tests for the Responses API wire path. Mocks
 * `client.responses.create` via the `__setOpenAIClientFactory` hook (no
 * network) and verifies: request shape (`input`/`instructions`, not
 * `messages`), end-to-end streaming → ProviderEvents, and that the
 * ChatGPT-subscription auth path wires the private backend baseURL + headers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import { __setOpenAIClientFactory, OpenAICompatibleQuery, type OpenAIClientFactory } from './query.js';
import type { ResponsesStreamEvent } from './responses-translate.js';
import { CHATGPT_BACKEND_BASE_URL } from './responses-config.js';
import type { OpenAIAuthResolution } from './auth.js';

type ClientOpts = { apiKey: string; baseURL?: string; defaultHeaders?: Record<string, string> };

let clientOptsSeen: ClientOpts | null = null;
let createArgsSeen: Record<string, unknown> | null = null;
let pendingEvents: ResponsesStreamEvent[] = [];

function installResponsesMock(): void {
  const factory: OpenAIClientFactory = (opts) => {
    clientOptsSeen = opts;
    return {
      responses: {
        create: async (args: { stream?: boolean }, options?: { signal?: AbortSignal }) => {
          createArgsSeen = args as Record<string, unknown>;
          const events = pendingEvents.slice();
          return (async function* () {
            for (const e of events) {
              if (options?.signal?.aborted) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
              }
              yield e;
            }
          })();
        },
      },
    } as unknown as OpenAI;
  };
  __setOpenAIClientFactory(factory);
}

afterEach(() => {
  __setOpenAIClientFactory(null);
  clientOptsSeen = null;
  createArgsSeen = null;
  pendingEvents = [];
});

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'gpt-5', systemPrompt: 'You are helpful.', ...over } as unknown as AgentConfig;
}

describe('query — Responses wire (public opt-in)', () => {
  it('streams text and emits turn.completed with mapped usage', async () => {
    installResponsesMock();
    pendingEvents = [
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'Hi' },
      { type: 'response.output_text.delta', delta: ' there' },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } },
      },
    ];
    const auth: OpenAIAuthResolution = { apiKey: 'sk-x', source: 'env' };
    const query = new OpenAICompatibleQuery({
      auth,
      model: 'gpt-5',
      synthesizedSessionId: 'sess-1',
      promptStream: singleInput('hello'),
      config: config(),
      useResponsesApi: true,
    });
    const events = await collect(query);

    const text = events.filter((e) => e.type === 'delta.text').map((e) => (e as { text: string }).text);
    expect(text.join('')).toBe('Hi there');

    const completed = events.find((e) => e.type === 'turn.completed') as
      | { type: 'turn.completed'; usage: { inputTokens?: number; outputTokens?: number } }
      | undefined;
    expect(completed?.usage.inputTokens).toBe(12);
    expect(completed?.usage.outputTokens).toBe(3);
  });

  it('sends Responses-shaped request (input + instructions, not messages)', async () => {
    installResponsesMock();
    pendingEvents = [{ type: 'response.completed', response: { status: 'completed' } }];
    const query = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-x', source: 'env' },
      model: 'gpt-5',
      synthesizedSessionId: 'sess-2',
      promptStream: singleInput('what is 2+2?'),
      config: config(),
      useResponsesApi: true,
    });
    await collect(query);

    expect(createArgsSeen).not.toBeNull();
    expect(createArgsSeen!['messages']).toBeUndefined();
    expect(createArgsSeen!['instructions']).toBe('You are helpful.');
    expect(createArgsSeen!['input']).toEqual([{ role: 'user', content: 'what is 2+2?' }]);
    expect(createArgsSeen!['stream']).toBe(true);
  });
});

describe('query — Responses wire (ChatGPT subscription auth)', () => {
  it('routes to the ChatGPT backend baseURL with the account-id + beta headers', async () => {
    installResponsesMock();
    pendingEvents = [{ type: 'response.completed', response: { status: 'completed' } }];
    const auth: OpenAIAuthResolution = {
      apiKey: 'access-token-xyz',
      source: 'chatgpt-oauth',
      accountId: 'acct_z',
    };
    const query = new OpenAICompatibleQuery({
      auth,
      model: 'gpt-5',
      synthesizedSessionId: 'sess-3',
      promptStream: singleInput('hi'),
      config: config(),
      // note: NOT setting useResponsesApi — chatgpt-oauth selects Responses automatically
    });
    await collect(query);

    expect(clientOptsSeen).not.toBeNull();
    expect(clientOptsSeen!.apiKey).toBe('access-token-xyz');
    expect(clientOptsSeen!.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
    expect(clientOptsSeen!.defaultHeaders).toMatchObject({
      'chatgpt-account-id': 'acct_z',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'agent-afk',
    });
  });
});
