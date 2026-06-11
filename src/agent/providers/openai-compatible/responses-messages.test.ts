import { describe, it, expect } from 'vitest';
import {
  buildResponsesRequest,
  responsesToolsFromOpenAITools,
  type BuildableMessage,
} from './responses-messages.js';
import type { OpenAIFunctionTool } from './loop.js';

describe('buildResponsesRequest', () => {
  it('hoists the system message into instructions and maps user/assistant text to input items', () => {
    const messages: BuildableMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Bye' },
    ];
    const req = buildResponsesRequest(messages);
    expect(req.instructions).toBe('You are helpful.');
    expect(req.input).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Bye' },
    ]);
    expect(req.tools).toBeUndefined();
  });

  it('omits instructions when there is no system message', () => {
    const req = buildResponsesRequest([{ role: 'user', content: 'Hi' }]);
    expect(req.instructions).toBeUndefined();
  });

  it('joins multiple system messages with a blank line', () => {
    const req = buildResponsesRequest([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
    ]);
    expect(req.instructions).toBe('A\n\nB');
  });

  it('maps an assistant tool-call turn to function_call items (with preamble text first)', () => {
    const messages: BuildableMessage[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '72F sunny' },
      { role: 'assistant', content: "It's 72F and sunny." },
    ];
    const req = buildResponsesRequest(messages);
    expect(req.input).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'let me check' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '72F sunny' },
      { role: 'assistant', content: "It's 72F and sunny." },
    ]);
  });

  it('handles a tool-only assistant turn (null content, no preamble item)', () => {
    const messages: BuildableMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c', content: 'ok' },
    ];
    const req = buildResponsesRequest(messages);
    expect(req.input).toEqual([
      { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c', output: 'ok' },
    ]);
  });
});

describe('responsesToolsFromOpenAITools', () => {
  it('flattens nested Chat-Completions tools to the Responses shape', () => {
    const nested: OpenAIFunctionTool[] = [
      { type: 'function', function: { name: 'a', description: 'does a', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b', parameters: { type: 'object' } } },
    ];
    expect(responsesToolsFromOpenAITools(nested)).toEqual([
      { type: 'function', name: 'a', parameters: { type: 'object', properties: {} }, description: 'does a' },
      { type: 'function', name: 'b', parameters: { type: 'object' } },
    ]);
  });

  it('returns [] for undefined/empty', () => {
    expect(responsesToolsFromOpenAITools(undefined)).toEqual([]);
    expect(responsesToolsFromOpenAITools([])).toEqual([]);
  });
});
