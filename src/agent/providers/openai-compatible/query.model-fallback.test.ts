/**
 * Query-level model-fallback tests: a `model.fallback_request` raised by the
 * quota tier reaches the provider's output unmodified through the ChatGPT-OAuth
 * refresh wrapper and the file-checkpoint event pass, ends the turn with no
 * further events (no paused/resumed, no synthetic terminal), and is only raised
 * on the first model request of the user turn.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import { __setOpenAIClientFactory, OpenAICompatibleQuery } from './query.js';
import type { OpenAIAuthResolution } from './auth.js';
import type { OpenAIChunk } from './translate.js';

afterEach(() => __setOpenAIClientFactory(null));

/** Each create() call takes the next script entry: an Error to throw, or chunks to stream. */
function installClient(script: Array<Error | OpenAIChunk[]>): { calls: () => number } {
  let n = 0;
  const create = async (): Promise<AsyncIterable<unknown>> => {
    const step = script[Math.min(n, script.length - 1)]!;
    n += 1;
    if (step instanceof Error) throw step;
    return (async function* () { for (const c of step) yield c; })();
  };
  __setOpenAIClientFactory(() => ({ responses: { create }, chat: { completions: { create } } }) as unknown as OpenAI);
  return { calls: () => n };
}

function chatGptUsageLimit(): Error {
  const body = { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_in_seconds: 600 };
  return Object.assign(new Error('429 The usage limit has been reached'), { status: 429, error: body, type: body.type });
}

function modelNotFound(): Error {
  const body = { code: 'model_not_found', message: 'The model `gpt-5.5` does not exist' };
  return Object.assign(new Error(body.message), { status: 404, code: body.code, error: body });
}

function toolCallRound(): OpenAIChunk[] {
  return [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/x"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ] as unknown as OpenAIChunk[];
}

async function* turns(...contents: string[]): AsyncIterable<ProviderUserTurn> {
  for (const content of contents) yield { content };
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

const chatgptAuth: OpenAIAuthResolution = { apiKey: 'tok', source: 'chatgpt-oauth', accountId: 'acct' };
const keyAuth: OpenAIAuthResolution = { apiKey: 'sk-x', source: 'env' };

function makeQuery(auth: OpenAIAuthResolution, config: Partial<AgentConfig>): OpenAICompatibleQuery {
  return new OpenAICompatibleQuery({
    auth,
    model: 'gpt-5.5',
    synthesizedSessionId: 'sess-fb',
    promptStream: turns('hi'),
    config: { model: 'gpt-5.5', systemPrompt: 'sys', enableFileCheckpointing: true, ...config } as unknown as AgentConfig,
  });
}

const afterInit = (events: ProviderEvent[]) => events.filter((e) => e.type !== 'session.init');

describe('OpenAICompatibleQuery — model.fallback_request', () => {
  it('ChatGPT usage limit: the request passes the OAuth wrapper + checkpoint pass unmodified and ends the turn', async () => {
    const err = chatGptUsageLimit();
    const client = installClient([err]);
    const events = afterInit(await collect(makeQuery(chatgptAuth, { modelFallbackArmed: () => true })));
    expect(events).toEqual([{ type: 'model.fallback_request', reason: 'usage-limit', error: err, sessionId: 'sess-fb' }]);
    expect((events[0] as { error: Error }).error).toBe(err);
    expect(client.calls()).toBe(1);
  });

  it('model rejection on the first request (API key, chat wire): one model-rejected request', async () => {
    const err = modelNotFound();
    installClient([err]);
    const events = afterInit(await collect(makeQuery(keyAuth, { modelFallbackArmed: true })));
    expect(events).toEqual([{ type: 'model.fallback_request', reason: 'model-rejected', error: err, sessionId: 'sess-fb' }]);
  });

  it('unattended surface (autoResumeOnUsageLimit=false) still requests instead of failing fast', async () => {
    installClient([chatGptUsageLimit()]);
    const events = afterInit(await collect(makeQuery(chatgptAuth, { modelFallbackArmed: true, autoResumeOnUsageLimit: false })));
    expect(events.map((e) => e.type)).toEqual(['model.fallback_request']);
  });

  it('not armed: today\'s fail-fast park (paused then error), no request', async () => {
    installClient([chatGptUsageLimit()]);
    const events = afterInit(await collect(makeQuery(chatgptAuth, { autoResumeOnUsageLimit: false })));
    expect(events.map((e) => e.type)).toEqual(['paused', 'error']);
  });

  it('quota 429 after a tool round already ran: parks as today, no request', async () => {
    const client = installClient([toolCallRound(), chatGptUsageLimit()]);
    const events = afterInit(await collect(makeQuery(keyAuth, { modelFallbackArmed: true, autoResumeOnUsageLimit: false })));
    // Round 0 dispatched a tool (no dispatcher here, so only the round-progress
    // event surfaces); round 1's limit must park, not request.
    expect(client.calls()).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['progress', 'paused', 'error']);
  });
});
