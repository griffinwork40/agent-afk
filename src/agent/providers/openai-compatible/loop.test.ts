import { describe, it, expect } from 'vitest';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import type { AccumulatedToolCall } from './translate.js';
import {
  toolDefsToOpenAIFunctions,
  accumulatedToolCallsToToolCalls,
  assistantMessageWithToolCalls,
  toolResultsToMessages,
  toolImageFollowupMessage,
  summarizeToolCalls,
} from './loop.js';

describe('toolDefsToOpenAIFunctions', () => {
  it('renames input_schema -> parameters', () => {
    const defs: AnthropicToolDef[] = [
      {
        name: 'bash',
        description: 'Run a command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ];
    const out = toolDefsToOpenAIFunctions(defs);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      },
    ]);
  });

  it('omits description when absent', () => {
    const out = toolDefsToOpenAIFunctions([
      { name: 'noop', input_schema: { type: 'object' } },
    ]);
    expect(out[0]!.function).not.toHaveProperty('description');
  });

  it('preserves property order and required arrays', () => {
    const out = toolDefsToOpenAIFunctions([
      {
        name: 'edit_file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    ]);
    const params = out[0]!.function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties)).toEqual(['file_path', 'old_string', 'new_string']);
    expect(params.required).toEqual(['file_path', 'old_string', 'new_string']);
  });
});

describe('accumulatedToolCallsToToolCalls', () => {
  const signal = new AbortController().signal;

  it('parses valid JSON arguments', () => {
    const calls: AccumulatedToolCall[] = [
      { index: 0, id: 'call_a', name: 'bash', argumentsRaw: '{"command":"ls"}', startEmitted: false },
    ];
    const { calls: out, parseErrors } = accumulatedToolCallsToToolCalls(calls, signal);
    expect(out).toEqual([
      { id: 'call_a', name: 'bash', input: { command: 'ls' }, signal },
    ]);
    expect(parseErrors.size).toBe(0);
  });

  it('records JSON parse errors but still creates a ToolCall with empty input', () => {
    const calls: AccumulatedToolCall[] = [
      { index: 0, id: 'call_x', name: 'bash', argumentsRaw: '{not valid', startEmitted: false },
    ];
    const { calls: out, parseErrors } = accumulatedToolCallsToToolCalls(calls, signal);
    expect(out).toHaveLength(1);
    expect(out[0]!.input).toEqual({});
    expect(parseErrors.get('call_x')).toMatch(/Failed to parse/);
  });

  it('handles empty argument strings as empty object input', () => {
    const { calls } = accumulatedToolCallsToToolCalls(
      [{ index: 0, id: 'call_n', name: 'noop', argumentsRaw: '', startEmitted: false }],
      signal,
    );
    expect(calls[0]!.input).toEqual({});
  });

  it('threads signal onto every ToolCall', () => {
    const { calls } = accumulatedToolCallsToToolCalls(
      [
        { index: 0, id: 'a', name: 'bash', argumentsRaw: '{}', startEmitted: false },
        { index: 1, id: 'b', name: 'read_file', argumentsRaw: '{}', startEmitted: false },
      ],
      signal,
    );
    expect(calls.every((c) => c.signal === signal)).toBe(true);
  });
});

describe('assistantMessageWithToolCalls', () => {
  it('sets content to null when accumulatedText is empty (tool-only turn)', () => {
    const msg = assistantMessageWithToolCalls('', [
      { index: 0, id: 'a', name: 'bash', argumentsRaw: '{"c":1}', startEmitted: false },
    ]);
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toEqual([
      { id: 'a', type: 'function', function: { name: 'bash', arguments: '{"c":1}' } },
    ]);
  });

  it('keeps preamble text alongside tool_calls when both present', () => {
    const msg = assistantMessageWithToolCalls('Let me check that file.', [
      { index: 0, id: 'a', name: 'read_file', argumentsRaw: '{"p":"x"}', startEmitted: false },
    ]);
    expect(msg.content).toBe('Let me check that file.');
    expect(msg.tool_calls).toHaveLength(1);
  });

  it('preserves order across multiple tool calls', () => {
    const msg = assistantMessageWithToolCalls('', [
      { index: 0, id: 'a', name: 'bash', argumentsRaw: '{}', startEmitted: false },
      { index: 1, id: 'b', name: 'read_file', argumentsRaw: '{}', startEmitted: false },
    ]);
    expect(msg.tool_calls.map((t) => t.id)).toEqual(['a', 'b']);
  });

  describe('reasoning_content echo (DeepSeek-R1 thinking-mode protocol)', () => {
    // Regression: DeepSeek-R1 and other thinking-mode providers on
    // OpenAI-compatible endpoints emit a `reasoning_content` field separate
    // from `content` and require it echoed back on the assistant turn it
    // came from. Without the echo, DeepSeek returns:
    //   400 "The `reasoning_content` in the thinking mode must be passed
    //         back to the API."

    it('attaches reasoning_content when reasoningText is non-empty', () => {
      const msg = assistantMessageWithToolCalls(
        'Let me check.',
        [{ index: 0, id: 'a', name: 'bash', argumentsRaw: '{}', startEmitted: false }],
        'First I should look at the file structure to understand the layout.',
      );
      expect(msg.reasoning_content).toBe(
        'First I should look at the file structure to understand the layout.',
      );
      expect(msg.content).toBe('Let me check.');
      expect(msg.tool_calls).toHaveLength(1);
    });

    it('omits reasoning_content entirely when reasoningText is empty (default)', () => {
      // Real OpenAI o-series doesn't expose reasoning, so reasoningText
      // stays empty. The field MUST be absent (not empty string) — OpenAI's
      // schema validation rejects unknown fields strictly.
      const msg = assistantMessageWithToolCalls('Plain answer.', []);
      expect(msg).not.toHaveProperty('reasoning_content');
    });

    it('omits reasoning_content when reasoningText is explicitly empty string', () => {
      const msg = assistantMessageWithToolCalls('Plain answer.', [], '');
      expect(msg).not.toHaveProperty('reasoning_content');
    });

    it('attaches reasoning_content on tool-only assistant turns (no preamble text)', () => {
      const msg = assistantMessageWithToolCalls(
        '',
        [{ index: 0, id: 'a', name: 'bash', argumentsRaw: '{}', startEmitted: false }],
        'I need to run a command.',
      );
      expect(msg.content).toBeNull();
      expect(msg.reasoning_content).toBe('I need to run a command.');
    });
  });
});

describe('toolResultsToMessages', () => {
  it('maps results to role:tool messages with tool_call_id', () => {
    const signal = new AbortController().signal;
    const out = toolResultsToMessages([
      { call: { id: 'a', name: 'bash', input: {}, signal }, result: { content: 'hello' } },
      { call: { id: 'b', name: 'read_file', input: {}, signal }, result: { content: 'file contents' } },
    ]);
    expect(out).toEqual([
      { role: 'tool', tool_call_id: 'a', content: 'hello' },
      { role: 'tool', tool_call_id: 'b', content: 'file contents' },
    ]);
  });

  it('prefixes errors with [error] so the model can recognize them', () => {
    const signal = new AbortController().signal;
    const out = toolResultsToMessages([
      {
        call: { id: 'a', name: 'bash', input: {}, signal },
        result: { content: 'permission denied', isError: true },
      },
    ]);
    expect(out[0]!.content).toBe('[error] permission denied');
  });

  it('never carries the image payload on the role:tool message (OpenAI limit)', () => {
    const signal = new AbortController().signal;
    const out = toolResultsToMessages([
      {
        call: { id: 'a', name: 'browser_screenshot', input: {}, signal },
        result: { content: 'shot saved 800x600', image: { mediaType: 'image/png', data: 'AAAA' } },
      },
    ]);
    // Text summary rides the tool message; no image content.
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'a', content: 'shot saved 800x600' }]);
  });
});

describe('toolImageFollowupMessage', () => {
  const signal = new AbortController().signal;

  it('returns undefined when the model lacks vision', () => {
    const out = toolImageFollowupMessage(
      [
        {
          call: { id: 'a', name: 'browser_screenshot', input: {}, signal },
          result: { content: 'shot', image: { mediaType: 'image/png', data: 'AAAA' } },
        },
      ],
      { vision: false },
    );
    expect(out).toBeUndefined();
  });

  it('returns undefined when no result carried an image', () => {
    const out = toolImageFollowupMessage(
      [{ call: { id: 'a', name: 'bash', input: {}, signal }, result: { content: 'ok' } }],
      { vision: true },
    );
    expect(out).toBeUndefined();
  });

  it('builds a role:user message with image_url parts for a vision model', () => {
    const out = toolImageFollowupMessage(
      [
        {
          call: { id: 'a', name: 'browser_screenshot', input: {}, signal },
          result: { content: 'shot', image: { mediaType: 'image/png', data: 'AAAA' } },
        },
      ],
      { vision: true },
    );
    expect(out?.role).toBe('user');
    const content = out!.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(content[0]!['text']).toContain('browser_screenshot');
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });

  it('aggregates images from multiple tool calls', () => {
    const out = toolImageFollowupMessage(
      [
        {
          call: { id: 'a', name: 'browser_screenshot', input: {}, signal },
          result: { content: 's1', image: { mediaType: 'image/png', data: 'AAAA' } },
        },
        { call: { id: 'b', name: 'bash', input: {}, signal }, result: { content: 'no image' } },
        {
          call: { id: 'c', name: 'chart_tool', input: {}, signal },
          result: { content: 's2', image: { mediaType: 'image/jpeg', data: 'BBBB' } },
        },
      ],
      { vision: true },
    );
    const content = out!.content as Array<Record<string, unknown>>;
    // 1 text label + 2 image parts (the no-image bash result is skipped).
    expect(content).toHaveLength(3);
    expect(content[1]).toMatchObject({ type: 'image_url' });
    expect(content[2]).toMatchObject({ type: 'image_url' });
  });
});

describe('summarizeToolCalls', () => {
  it('returns empty string for empty input', () => {
    expect(summarizeToolCalls([])).toBe('');
  });

  it('uses singular form for one call', () => {
    expect(
      summarizeToolCalls([
        { index: 0, id: 'a', name: 'bash', argumentsRaw: '{}', startEmitted: false },
      ]),
    ).toBe('called bash');
  });

  it('lists names for multiple calls', () => {
    expect(
      summarizeToolCalls([
        { index: 0, id: 'a', name: 'bash', argumentsRaw: '{}', startEmitted: false },
        { index: 1, id: 'b', name: 'read_file', argumentsRaw: '{}', startEmitted: false },
      ]),
    ).toBe('called 2 tools: bash, read_file');
  });
});
