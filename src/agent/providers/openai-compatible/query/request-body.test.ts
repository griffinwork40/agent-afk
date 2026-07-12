/**
 * Unit tests for the extracted per-wire request-body builders (#365).
 * Lock the wire-specific body shapes — especially the private ChatGPT/Codex
 * backend gating (no output cap; forced instructions + store:false) — that used
 * to live inline in runIteration.
 */

import { describe, it, expect } from 'vitest';
import type { OpenAIMessage } from '../messages.js';
import type { OpenAIFunctionTool } from '../loop.js';
import { buildChatCompletionsRequestBody, buildResponsesRequestBody } from './request-body.js';

const MESSAGES: OpenAIMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
];

const TOOLS = [
  { type: 'function', function: { name: 'do_thing', parameters: { type: 'object', properties: {} } } },
] as unknown as OpenAIFunctionTool[];

describe('buildChatCompletionsRequestBody', () => {
  it('always sets model, messages, stream, and usage-inclusive stream_options', () => {
    const body = buildChatCompletionsRequestBody({
      model: 'gpt-4o',
      messages: MESSAGES,
      activeTools: undefined,
      maxOutputTokens: 1024,
      effort: undefined,
    });
    expect(body['model']).toBe('gpt-4o');
    expect(body['messages']).toBe(MESSAGES);
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
  });

  it('attaches tools only when non-empty', () => {
    const withTools = buildChatCompletionsRequestBody({
      model: 'gpt-4o',
      messages: MESSAGES,
      activeTools: TOOLS,
      maxOutputTokens: undefined,
      effort: undefined,
    });
    expect(withTools['tools']).toBe(TOOLS);

    const noTools = buildChatCompletionsRequestBody({
      model: 'gpt-4o',
      messages: MESSAGES,
      activeTools: [],
      maxOutputTokens: undefined,
      effort: undefined,
    });
    expect('tools' in noTools).toBe(false);
  });
});

describe('buildResponsesRequestBody', () => {
  it('builds the Responses shape (input + stream) with an output cap on the public path', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-4o',
      messages: MESSAGES,
      activeTools: undefined,
      maxOutputTokens: 2048,
      effort: undefined,
      isChatGptBackend: false,
    });
    expect(body['stream']).toBe(true);
    expect('input' in body).toBe(true);
    // Public API-key path applies the output cap and does NOT force store/instructions.
    expect('max_output_tokens' in body).toBe(true);
    expect('store' in body).toBe(false);
  });

  it('omits the output cap and forces store:false + instructions on the ChatGPT backend', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-5.5',
      messages: MESSAGES,
      activeTools: undefined,
      maxOutputTokens: 2048,
      effort: undefined,
      isChatGptBackend: true,
    });
    // The subscription backend 400s on every output-cap param — must be absent.
    expect('max_output_tokens' in body).toBe(false);
    expect(body['store']).toBe(false);
    // A non-empty instructions is required on this backend.
    expect(typeof body['instructions']).toBe('string');
    expect((body['instructions'] as string).length).toBeGreaterThan(0);
  });
});
