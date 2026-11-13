/**
 * Wire-level fakes for the model-fallback integration suites
 * (model-fallback.integration*.test.ts). Only the network boundary is faked:
 * the Anthropic SDK client (`messages.create`) and the OpenAI client
 * (`chat.completions.create`). Everything above it (retry tiers, inner
 * providers, ProviderRouter, AgentSession, journal) is real.
 *
 * @module agent/session/__test-utils__/model-fallback-wire
 */
import { __setAnthropicClientFactory } from '../../providers/anthropic-direct/index.js';
import { __setOpenAIClientFactory } from '../../providers/openai-compatible/query.js';
import type { AgentSession } from '../agent-session.js';
import type { OutputEvent } from '../../types.js';

/** One scripted wire response: an error to throw, or a stream to replay (optionally throwing at the end). */
export type WireStep = Error | { events: unknown[]; thenThrow?: Error };

/** Recorded request bodies, in order, across both wires. */
export interface WireLog {
  bodies: Array<{ wire: 'anthropic' | 'openai'; model: string; body: Record<string, unknown> }>;
}

/**
 * Install fake SDK clients. `script(model, nthCallForThatModel)` decides each
 * response. Returns the shared request log.
 */
export function installWire(script: (model: string, n: number) => WireStep): WireLog {
  const log: WireLog = { bodies: [] };
  const counts = new Map<string, number>();
  const respond = (wire: 'anthropic' | 'openai', body: Record<string, unknown>): AsyncIterable<unknown> => {
    const model = String(body['model']);
    const n = counts.get(model) ?? 0;
    counts.set(model, n + 1);
    // Deep copy: the providers mutate their message arrays after the call.
    log.bodies.push({ wire, model, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown> });
    const step = script(model, n);
    if (step instanceof Error) throw step;
    return (async function* () {
      for (const e of step.events) yield e;
      if (step.thenThrow) throw step.thenThrow;
    })();
  };
  const anthropicCreate = (body: Record<string, unknown>): AsyncIterable<unknown> => respond('anthropic', body);
  __setAnthropicClientFactory(() => ({ messages: { create: anthropicCreate } }) as never);
  const openaiCreate = async (body: Record<string, unknown>): Promise<AsyncIterable<unknown>> => respond('openai', body);
  __setOpenAIClientFactory(
    () => ({ responses: { create: openaiCreate }, chat: { completions: { create: openaiCreate } } }) as never,
  );
  return log;
}

export function uninstallWire(): void {
  __setAnthropicClientFactory(null);
  __setOpenAIClientFactory(null);
}

const usage = { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
/** A raw SDK stream event (shape-only; the SDK type is not imported outside providers). */
type RawEvent = Record<string, unknown>;
const ev = (e: RawEvent): RawEvent => e;

function messageStart(model: string): RawEvent {
  return ev({
    type: 'message_start',
    message: { id: 'msg_t', type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage },
  });
}

/** A complete Anthropic text answer (`end_turn`). */
export function anthropicText(model: string, text: string): RawEvent[] {
  return [
    messageStart(model),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    ev({ type: 'message_stop' }),
  ];
}

/** A partial Anthropic answer: text streamed, no stop (the wire then throws). */
export function anthropicPartialText(model: string, text: string): RawEvent[] {
  return anthropicText(model, text).slice(0, 3);
}

/** An Anthropic round that calls a tool (`tool_use`). */
export function anthropicToolUse(model: string, name: string, input: Record<string, unknown>): RawEvent[] {
  return [
    messageStart(model),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }),
    ev({ type: 'message_stop' }),
  ];
}

/** A complete OpenAI Chat Completions text answer. */
export function openaiText(text: string): unknown[] {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
}

function apiError(status: number, message: string, body?: { type: string; message: string }): Error {
  const e = new Error(message) as Error & { status: number; error?: unknown; headers?: unknown };
  e.status = status;
  e.headers = {};
  if (body) e.error = { type: 'error', error: body };
  return e;
}

/** Anthropic subscription usage limit (`oauth-limit`, reset 30 min out). */
export function usageLimit429(): Error {
  return apiError(429, `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 1800}`);
}

/** Anthropic 404 rejecting the model id. */
export function modelNotFound404(model: string): Error {
  const message = `model: ${model}`;
  return apiError(404, `404 ${JSON.stringify({ type: 'error', error: { type: 'not_found_error', message } })}`, {
    type: 'not_found_error',
    message,
  });
}

/** Drive one turn as a session consumer would; returns every OutputEvent observed. */
export async function runTurn(session: AgentSession, text: string): Promise<OutputEvent[]> {
  const out: OutputEvent[] = [];
  for await (const e of session.sendMessageStream(text)) out.push(e);
  return out;
}

export const ofType = <T extends OutputEvent['type']>(events: OutputEvent[], type: T): Array<Extract<OutputEvent, { type: T }>> =>
  events.filter((e): e is Extract<OutputEvent, { type: T }> => e.type === type);

export const fallbackNotices = (events: OutputEvent[]): Array<Extract<OutputEvent, { type: 'notice' }>> =>
  ofType(events, 'notice').filter((n) => n.kind === 'model-fallback');

export const terminals = (events: OutputEvent[]): OutputEvent[] =>
  events.filter((e) => e.type === 'done' || e.type === 'error');

export const streamedText = (events: OutputEvent[]): string =>
  ofType(events, 'chunk')
    .map((c) => (c.chunk.type === 'content' ? c.chunk.content : ''))
    .join('');

/** Count occurrences of `needle` across a serialized request's `messages`. */
export function occurrences(body: Record<string, unknown>, needle: string): number {
  return JSON.stringify(body['messages'] ?? []).split(needle).length - 1;
}
