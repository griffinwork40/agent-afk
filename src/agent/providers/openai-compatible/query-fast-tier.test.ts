/**
 * Query-level tests for OpenAI fast mode (`service_tier: "priority"`). Drives a
 * real OpenAICompatibleQuery against a mocked client (no network) and checks
 * the wire body on both the ChatGPT-subscription Responses path and the
 * API-key Chat Completions path, the applied-tier notice, the 400 latch +
 * retry, and confirmed-tier pricing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import { FastModeController } from '../../fast-mode.js';
import { __setOpenAIClientFactory, OpenAICompatibleQuery } from './query.js';
import type { ResponsesStreamEvent } from './responses-translate.js';
import type { OpenAIAuthResolution } from './auth.js';
import type { FastTierOptions } from './query/fast-tier-session.js';

let calls: Array<Record<string, unknown>> = [];
let responseTier: string | undefined;
let failFirstWith: unknown = null;

function completedEvents(): ResponsesStreamEvent[] {
  return [
    { type: 'response.output_text.delta', delta: 'ok' },
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: { input_tokens: 1000, output_tokens: 100 },
        ...(responseTier !== undefined ? { service_tier: responseTier } : {}),
      },
    } as ResponsesStreamEvent,
  ];
}

function chatChunks(): unknown[] {
  const tier = responseTier !== undefined ? { service_tier: responseTier } : {};
  return [
    { choices: [{ index: 0, delta: { content: 'ok' } }], ...tier },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...tier },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 }, ...tier },
  ];
}

function installMock(): void {
  __setOpenAIClientFactory(() => {
    const record = async <T>(args: unknown, items: () => T[]): Promise<AsyncIterable<T>> => {
      calls.push(args as Record<string, unknown>);
      if (failFirstWith !== null && calls.length === 1) throw failFirstWith;
      const list = items();
      return (async function* () { for (const e of list) yield e; })();
    };
    return {
      responses: { create: async (args: unknown) => record(args, completedEvents) },
      chat: { completions: { create: async (args: unknown) => record(args, chatChunks) } },
    } as unknown as OpenAI;
  });
}

afterEach(() => {
  __setOpenAIClientFactory(null);
  calls = [];
  responseTier = undefined;
  failFirstWith = null;
});

async function* turns(...contents: string[]): AsyncIterable<ProviderUserTurn> {
  for (const content of contents) yield { content };
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

const chatgptAuth: OpenAIAuthResolution = { apiKey: 'tok', source: 'chatgpt-oauth', accountId: 'acct_z' };
const keyAuth: OpenAIAuthResolution = { apiKey: 'sk-x', source: 'env' };

function fastTier(pref: 'on' | 'off' = 'on', hasCustomEndpoint = false): FastTierOptions {
  return { controller: new FastModeController(pref), hasCustomEndpoint };
}

function makeQuery(opts: {
  auth?: OpenAIAuthResolution;
  model?: string;
  fast?: FastTierOptions;
  prompts?: string[];
}): OpenAICompatibleQuery {
  const model = opts.model ?? 'gpt-5.5';
  return new OpenAICompatibleQuery({
    auth: opts.auth ?? chatgptAuth,
    model,
    synthesizedSessionId: 'sess-fast',
    promptStream: turns(...(opts.prompts ?? ['hi'])),
    config: { model, systemPrompt: 'sys' } as unknown as AgentConfig,
    ...(opts.fast !== undefined ? { fastTier: opts.fast } : {}),
  });
}

const notices = (events: ProviderEvent[]) =>
  events.filter((e): e is Extract<ProviderEvent, { type: 'notice' }> => e.type === 'notice');

describe('OpenAI fast mode — ChatGPT subscription (Responses wire)', () => {
  it('sends service_tier "priority" when /fast is on and the model is eligible', async () => {
    installMock();
    responseTier = 'priority';
    const events = await collect(makeQuery({ fast: fastTier('on') }));
    expect(calls[0]!['service_tier']).toBe('priority');
    expect(notices(events)).toHaveLength(0);
  });

  it('omits service_tier when /fast is off', async () => {
    installMock();
    await collect(makeQuery({ fast: fastTier('off') }));
    expect(calls[0]).not.toHaveProperty('service_tier');
  });

  it('omits service_tier with no fast wiring (forks / non-REPL surfaces)', async () => {
    installMock();
    await collect(makeQuery({}));
    expect(calls[0]).not.toHaveProperty('service_tier');
  });

  it('omits service_tier on a custom endpoint', async () => {
    installMock();
    await collect(makeQuery({ fast: fastTier('on', true) }));
    expect(calls[0]).not.toHaveProperty('service_tier');
  });

  it('omits service_tier for an ineligible model', async () => {
    installMock();
    await collect(makeQuery({ model: 'gpt-4o', fast: fastTier('on') }));
    expect(calls[0]).not.toHaveProperty('service_tier');
  });

  it('emits one fast-tier notice when the response reports a downgrade', async () => {
    installMock();
    responseTier = 'default';
    const events = await collect(makeQuery({ fast: fastTier('on'), prompts: ['a', 'b'] }));
    const n = notices(events);
    expect(n).toHaveLength(1);
    expect(n[0]!.kind).toBe('fast-tier');
    expect(n[0]!.text).toContain('"default"');
    // Still requested on the second turn; the notice is once per session.
    expect(calls[1]!['service_tier']).toBe('priority');
  });

  it('latches fast off and retries without service_tier when the backend rejects it', async () => {
    installMock();
    failFirstWith = Object.assign(new Error('400 Unsupported parameter: service_tier'), { status: 400 });
    const events = await collect(makeQuery({ fast: fastTier('on'), prompts: ['a', 'b'] }));
    expect(calls[0]!['service_tier']).toBe('priority');
    expect(calls[1]).not.toHaveProperty('service_tier'); // same-turn retry
    expect(calls[2]).not.toHaveProperty('service_tier'); // next turn stays off
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(notices(events)[0]!.text).toContain('turned off for this session');
  });

  it('does not swallow unrelated 400s', async () => {
    installMock();
    failFirstWith = Object.assign(new Error('400 bad model'), { status: 400 });
    const events = await collect(makeQuery({ fast: fastTier('on') }));
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('reads /fast preference per turn (toggle takes effect on the next turn)', async () => {
    installMock();
    const controller = new FastModeController('off');
    async function* prompts(): AsyncIterable<ProviderUserTurn> {
      yield { content: 'a' };
      controller.setPreference('on');
      yield { content: 'b' };
    }
    const query = new OpenAICompatibleQuery({
      auth: chatgptAuth, model: 'gpt-5.5', synthesizedSessionId: 's', promptStream: prompts(),
      config: { model: 'gpt-5.5', systemPrompt: 'sys' } as unknown as AgentConfig,
      fastTier: { controller, hasCustomEndpoint: false },
    });
    await collect(query);
    expect(calls[0]).not.toHaveProperty('service_tier');
    expect(calls[1]!['service_tier']).toBe('priority');
  });
});

describe('OpenAI fast mode — API key (Chat Completions wire)', () => {
  const costOf = (events: ProviderEvent[]) =>
    (events.find((e) => e.type === 'turn.completed') as { usage?: { totalCostUsd?: number } } | undefined)
      ?.usage?.totalCostUsd;

  it('sends service_tier "priority" and prices a confirmed priority turn at 2x', async () => {
    installMock();
    responseTier = 'default';
    const standard = costOf(await collect(makeQuery({ auth: keyAuth, model: 'gpt-5.6-sol' })));
    calls = [];
    responseTier = 'priority';
    const fast = costOf(await collect(makeQuery({ auth: keyAuth, model: 'gpt-5.6-sol', fast: fastTier('on') })));
    expect(calls[0]!['service_tier']).toBe('priority');
    expect(standard).toBeGreaterThan(0);
    expect(fast).toBeCloseTo(standard! * 2, 10);
  });

  it('prices a downgraded turn at the standard rate', async () => {
    installMock();
    const standard = costOf(await collect(makeQuery({ auth: keyAuth, model: 'gpt-5.6-sol' })));
    responseTier = 'default';
    const downgraded = costOf(await collect(makeQuery({ auth: keyAuth, model: 'gpt-5.6-sol', fast: fastTier('on') })));
    expect(downgraded).toBeCloseTo(standard!, 10);
  });
});
