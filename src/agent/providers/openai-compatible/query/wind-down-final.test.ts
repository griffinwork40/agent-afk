/**
 * Wind-down rounds keep the session's tools array (prefix-cache stability) and
 * never dispatch a tool call the model emits anyway. Refs #3963.
 *
 * Unit tests for the pure settlement helpers, plus end-to-end runs through
 * OpenAICompatibleQuery with a scripted Chat Completions client and a real
 * SessionToolDispatcher, so "nothing dispatched" is observed at the handler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../../provider.js';
import type { AgentConfig } from '../../../types/config-types.js';
import { SessionToolDispatcher } from '../../../tools/dispatcher.js';
import { createHookRegistry } from '../../../hooks.js';
import type { ToolHandler } from '../../../tools/types.js';
import { __setOpenAIClientFactory, OpenAICompatibleQuery, type OpenAIClientFactory } from '../query.js';
import type { OpenAIChunk } from '../translate.js';
import type { ResponsesStreamEvent } from '../responses-translate.js';
import { WIND_DOWN_NOTE } from '../../shared/tool-loop-cap.js';
import {
  stripToolCallMarkup,
  windDownFinalText,
  WIND_DOWN_NO_ANSWER_PLACEHOLDER,
} from './wind-down-final.js';

describe('stripToolCallMarkup / windDownFinalText', () => {
  it('removes Hermes/Qwen <tool_call> blocks and keeps surrounding prose', () => {
    const text = 'Findings: A and B.\n<tool_call>\n{"name":"bash","arguments":{"command":"ls"}}\n</tool_call>';
    expect(stripToolCallMarkup(text)).toBe('Findings: A and B.');
  });

  it('removes Qwen3-Coder <function=...> XML blocks, including unterminated ones', () => {
    const text = 'Partial.\n<tool_call>\n<function=write_file>\n<parameter=path>/tmp/x</parameter>';
    expect(stripToolCallMarkup(text)).toBe('Partial.');
    expect(stripToolCallMarkup('<function=bash><parameter=command>ls</parameter></function> done')).toBe('done');
  });

  it('removes Mistral-style [TOOL_CALLS] tails', () => {
    expect(stripToolCallMarkup('Answer.[TOOL_CALLS][{"name":"x"}]')).toBe('Answer.');
  });

  it('leaves ordinary text untouched (trimmed)', () => {
    expect(stripToolCallMarkup('  plain answer \n')).toBe('plain answer');
  });

  it('falls back to the explicit incomplete marker — never empty, never markup', () => {
    expect(windDownFinalText('')).toBe(WIND_DOWN_NO_ANSWER_PLACEHOLDER);
    expect(windDownFinalText('<tool_call>{"name":"bash"}</tool_call>')).toBe(WIND_DOWN_NO_ANSWER_PLACEHOLDER);
    expect(windDownFinalText('Real answer.')).toBe('Real answer.');
  });
});

// ---- end-to-end through the query loop ---------------------------------------

let scripted: OpenAIChunk[][] = [];
let createCalls: Array<Record<string, unknown>> = [];
const handlerCalls: unknown[] = [];

function install(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: Record<string, unknown>) => {
            createCalls.push(args);
            const chunks = scripted.shift();
            if (!chunks) throw new Error('no scripted turn');
            return (async function* () { for (const c of chunks) yield c; })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

function dispatcher(): SessionToolDispatcher {
  const echo: ToolHandler = async (input) => {
    handlerCalls.push(input);
    return { content: 'echoed' };
  };
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([['echo', echo]]),
    schemas: [{ name: 'echo', description: 'Echo', input_schema: { type: 'object', properties: {} } }],
    hookRegistry: createHookRegistry(),
  });
}

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const toolCallTurn = (id: string, content?: string): OpenAIChunk[] => [
  {
    choices: [{
      delta: {
        ...(content !== undefined ? { content } : {}),
        tool_calls: [{ index: 0, id, type: 'function', function: { name: 'echo', arguments: '{}' } }],
      },
    }],
  },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage },
];
const textTurn = (text: string): OpenAIChunk[] => [
  { choices: [{ delta: { content: text } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
];

async function run(maxToolUseIterations: number): Promise<ProviderEvent[]> {
  async function* input(): AsyncIterable<ProviderUserTurn> { yield { content: 'go' }; }
  const q = new OpenAICompatibleQuery({
    auth: { apiKey: 'sk', source: 'config' },
    model: 'gpt-4o-mini',
    synthesizedSessionId: 'sid',
    promptStream: input(),
    config: { model: 'gpt-4o-mini', apiKey: 'sk', maxToolUseIterations } as AgentConfig,
    toolDispatcher: dispatcher(),
  });
  const events: ProviderEvent[] = [];
  for await (const ev of q) events.push(ev);
  return events;
}

function finalAnswer(events: ProviderEvent[]): string | undefined {
  const msgs = events.filter((e) => e.type === 'assistant.message');
  const last = msgs.at(-1);
  return last?.type === 'assistant.message' ? last.text : undefined;
}

describe('openai-compatible wind-down round keeps tools and never dispatches', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_VITALS', '0');
    scripted = [];
    createCalls = [];
    handlerCalls.length = 0;
    install();
  });
  afterEach(() => {
    __setOpenAIClientFactory(null);
    vi.unstubAllEnvs();
  });

  it('sends the identical tools array, no tool_choice, and the wind-down note', async () => {
    scripted = [toolCallTurn('c0'), textTurn('Final answer.')];
    const events = await run(1);
    expect(createCalls).toHaveLength(2);
    const [normal, windDown] = createCalls as [Record<string, unknown>, Record<string, unknown>];
    expect(Array.isArray(normal['tools']) && (normal['tools'] as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(windDown['tools'])).toBe(JSON.stringify(normal['tools']));
    expect('tool_choice' in windDown).toBe(false);
    const msgs = windDown['messages'] as Array<{ content: unknown }>;
    expect(msgs.at(-1)?.content).toBe(WIND_DOWN_NOTE);
    expect(finalAnswer(events)).toBe('Final answer.');
  });

  it('a structured tool call on the wind-down round is NOT dispatched; text is the answer', async () => {
    scripted = [toolCallTurn('c0'), toolCallTurn('c1', 'Here is what I found.')];
    const events = await run(1);
    expect(createCalls).toHaveLength(2); // no third round
    expect(handlerCalls).toHaveLength(1); // only the pre-wind-down call ran
    expect(events.filter((e) => e.type === 'tool.use.start')).toHaveLength(1);
    expect(finalAnswer(events)).toBe('Here is what I found.');
    const completed = events.at(-1);
    expect(completed?.type === 'turn.completed' && completed.usage.stopReason).toBe('tool_use_loop_capped');
  });

  it('a textless structured tool call yields the incomplete marker, not stale planning text', async () => {
    scripted = [toolCallTurn('c0', 'Let me write the file...'), toolCallTurn('c1')];
    const events = await run(1);
    expect(handlerCalls).toHaveLength(1);
    expect(finalAnswer(events)).toBe(WIND_DOWN_NO_ANSWER_PLACEHOLDER);
  });

  it('tool-call markup in wind-down text is stripped; markup-only text yields the marker', async () => {
    scripted = [toolCallTurn('c0'), textTurn('Partial result.\n<tool_call>{"name":"echo","arguments":{}}</tool_call>')];
    expect(finalAnswer(await run(1))).toBe('Partial result.');
    expect(handlerCalls).toHaveLength(1);

    scripted = [toolCallTurn('c0'), textTurn('<tool_call>\n<function=echo>\n</function>\n</tool_call>')];
    createCalls = [];
    handlerCalls.length = 0;
    expect(finalAnswer(await run(1))).toBe(WIND_DOWN_NO_ANSWER_PLACEHOLDER);
    expect(handlerCalls).toHaveLength(1);
  });
});

// ---- Responses-wire wind-down ------------------------------------------------

let responsesCreateCalls: Record<string, unknown>[] = [];
const responsesHandlerCalls: unknown[] = [];

const textResponsesTurn = (text: string): ResponsesStreamEvent[] => [
  { type: 'response.output_text.delta', delta: text, output_index: 0 },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];

const toolCallResponsesTurn = (): ResponsesStreamEvent[] => [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item0', call_id: 'call0', name: 'echo' } },
  { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
  { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{}', name: 'echo' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'item0', call_id: 'call0', name: 'echo', arguments: '{}' } },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];

function installResponsesFactory(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      responses: {
        create: async (args: Record<string, unknown>) => {
          responsesCreateCalls.push(args);
          const chunks = responsesScripted.shift();
          if (!chunks) throw new Error('no scripted responses turn');
          return (async function* () { for (const c of chunks) yield c; })();
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

let responsesScripted: ResponsesStreamEvent[][] = [];

function responsesDispatcher(): SessionToolDispatcher {
  const echo: ToolHandler = async (input) => {
    responsesHandlerCalls.push(input);
    return { content: 'echoed' };
  };
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([['echo', echo]]),
    schemas: [{ name: 'echo', description: 'Echo', input_schema: { type: 'object', properties: {} } }],
    hookRegistry: createHookRegistry(),
  });
}

async function runResponses(maxToolUseIterations: number): Promise<ProviderEvent[]> {
  async function* input(): AsyncIterable<ProviderUserTurn> { yield { content: 'go' }; }
  const q = new OpenAICompatibleQuery({
    auth: { apiKey: 'sk', source: 'config' },
    model: 'gpt-4o-mini',
    synthesizedSessionId: 'sid-resp',
    promptStream: input(),
    config: { model: 'gpt-4o-mini', apiKey: 'sk', maxToolUseIterations } as AgentConfig,
    toolDispatcher: responsesDispatcher(),
    useResponsesApi: true,
  });
  const events: ProviderEvent[] = [];
  for await (const ev of q) events.push(ev);
  return events;
}

describe('openai-compatible wind-down round — Responses wire keeps tools and never dispatches', () => {
  beforeEach(() => {
    vi.stubEnv('AFK_VITALS', '0');
    responsesScripted = [];
    responsesCreateCalls = [];
    responsesHandlerCalls.length = 0;
    installResponsesFactory();
  });
  afterEach(() => {
    __setOpenAIClientFactory(null);
    vi.unstubAllEnvs();
  });

  it('sends the identical tools array on the Responses wire wind-down round', async () => {
    responsesScripted = [toolCallResponsesTurn(), textResponsesTurn('Final answer.')];
    const events = await runResponses(1);
    expect(responsesCreateCalls).toHaveLength(2);
    const [normal, windDown] = responsesCreateCalls as [Record<string, unknown>, Record<string, unknown>];
    expect(Array.isArray(normal['tools']) && (normal['tools'] as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(windDown['tools'])).toBe(JSON.stringify(normal['tools']));
    expect('tool_choice' in windDown).toBe(false);
    expect(finalAnswer(events)).toBe('Final answer.');
  });

  it('Responses-wire wind-down: structured tool call is NOT dispatched; text is the answer', async () => {
    responsesScripted = [toolCallResponsesTurn(), toolCallResponsesTurn()];
    const events = await runResponses(1);
    expect(responsesCreateCalls).toHaveLength(2); // no third round
    expect(responsesHandlerCalls).toHaveLength(1); // only the pre-wind-down call ran
    expect(events.filter((e) => e.type === 'tool.use.start')).toHaveLength(1);
    const completed = events.at(-1);
    expect(completed?.type === 'turn.completed' && completed.usage.stopReason).toBe('tool_use_loop_capped');
  });

  it('Responses-wire wind-down: text answer is extracted correctly', async () => {
    responsesScripted = [toolCallResponsesTurn(), textResponsesTurn('Partial result.\n<tool_call>{"name":"echo","arguments":{}}</tool_call>')];
    expect(finalAnswer(await runResponses(1))).toBe('Partial result.');
    expect(responsesHandlerCalls).toHaveLength(1);
  });
});
