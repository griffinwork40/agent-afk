/**
 * Regression test for the fork-scoped central output-cap wiring (#661).
 *
 * `subagent-output-cap.test.ts` proves that `SubagentManager.forkSubagent`
 * STAMPS the explicit `AgentConfig.subagentToolOutputCapBytes` signal on every
 * fork (even a stub-parent skill fork). This file proves the OTHER half: that
 * `AnthropicDirectProvider.buildDispatcher` ARMS the dispatcher's
 * `maxOutputBytes` backstop from that signal — so a forked child's tool output
 * is actually bounded — and, critically, that it is keyed on the NEW field, not
 * the leaky `parentSessionId` heuristic it replaced.
 *
 * Observation point: the `tool.output` ProviderEvent. When the cap is armed and
 * a tool returns content over budget, the dispatcher reduces it to head+tail
 * (the truncation marker) and the observed content is ≤ the cap. When the cap
 * is not armed, the full content rides through untouched.
 *
 * Mirrors the mock-Anthropic + query({config}) shape of
 * plan-mode-gate-wiring.test.ts so this exercises the REAL provider→dispatcher
 * path (not a hand-built dispatcher).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { tool } from '../../tools/custom-tool.js';
import { MODEL_CAP_BYTES } from '../../tools/handlers/_output-cap.js';

// --- Mock Anthropic Messages-API plumbing (mirrors plan-mode-gate-wiring.test.ts) ---

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

function makeToolUseStream(toolId: string, toolName: string, inputJson: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_t',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_done',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** UTF-8 byte size that comfortably exceeds MODEL_CAP_BYTES (100KB). */
const OVERSIZE_BYTES = MODEL_CAP_BYTES + 50_000;
const TRUNC_MARKER = /… \[\d+ bytes truncated: showing first \d+ \+ last \d+ of \d+\] …/;

/** A custom tool that returns `OVERSIZE_BYTES` of content, unconditionally. */
const bigTool = tool(
  'big_output',
  'Returns a large blob of text for output-cap testing.',
  z.object({}),
  async () => ({ content: 'A'.repeat(OVERSIZE_BYTES) }),
);

function toolOutputOf(events: ProviderEvent[]): { content: string; isError?: boolean } {
  const ev = events.find((e) => e.type === 'tool.output');
  if (!ev || ev.type !== 'tool.output') {
    throw new Error('expected a tool.output event');
  }
  return { content: ev.content, ...(ev.isError !== undefined ? { isError: ev.isError } : {}) };
}

describe('AnthropicDirectProvider — central output cap armed from config.subagentToolOutputCapBytes (#661)', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_big', 'big_output', '{}'));
      }
      return fromArray(makeTextStream('done'));
    });
  });

  it('CAPS a forked child (subagentToolOutputCapBytes set) even when parentSessionId is UNDEFINED', async () => {
    // The exact leaky-gate case: a skill-forked descendant has no
    // parentSessionId (stub parent) but IS a fork. The explicit signal must arm
    // the cap regardless.
    const provider = new AnthropicDirectProvider({ customTools: [bigTool] });
    const query = provider.query({
      prompt: singleInput('call the tool'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        // Fork signal present; parentSessionId deliberately ABSENT.
        subagentToolOutputCapBytes: MODEL_CAP_BYTES,
      },
    });

    const out = toolOutputOf(await collect(query));
    expect(out.content).toMatch(TRUNC_MARKER);
    expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(MODEL_CAP_BYTES);
    // Head preserved (head+tail, not tail-only).
    expect(out.content.startsWith('A')).toBe(true);
  });

  it('does NOT cap a top-level session (no subagentToolOutputCapBytes, no parentSessionId)', async () => {
    // Top-level sessions are built via `new AgentSession(...)` directly and
    // never carry the fork signal ⇒ uncapped, full output passes through.
    const provider = new AnthropicDirectProvider({ customTools: [bigTool] });
    const query = provider.query({
      prompt: singleInput('call the tool'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
      },
    });

    const out = toolOutputOf(await collect(query));
    expect(out.content).not.toMatch(TRUNC_MARKER);
    expect(Buffer.byteLength(out.content, 'utf8')).toBe(OVERSIZE_BYTES);
  });

  it('does NOT cap when only parentSessionId is set (proves the cap no longer keys on parentSessionId)', async () => {
    // Regression guard for the fix's core change: a config that carries a
    // parentSessionId but NOT the explicit signal must NOT be capped by the
    // central backstop. This pins that the arming condition migrated off
    // `parentSessionId` — a session wired with parentSessionId but without the
    // fork-cap field (a shape the manager no longer produces, asserted here as
    // a pure provider-contract guard) is left uncapped.
    const provider = new AnthropicDirectProvider({ customTools: [bigTool] });
    const query = provider.query({
      prompt: singleInput('call the tool'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        parentSessionId: 'parent-session-123',
        // subagentToolOutputCapBytes intentionally UNSET.
      },
    });

    const out = toolOutputOf(await collect(query));
    expect(out.content).not.toMatch(TRUNC_MARKER);
    expect(Buffer.byteLength(out.content, 'utf8')).toBe(OVERSIZE_BYTES);
  });
});
