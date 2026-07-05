/**
 * Regression: the model-callable `exit_plan_mode` tool must be advertised (and
 * callable) based on the LIVE permission mode, not the mode captured at
 * `query()` construction.
 *
 * The bug: `buildDispatcher` registered the tool's handler + schema ONLY when
 * `permissionMode === 'plan'` at construction, and `setPermissionMode` does not
 * rebuild the dispatcher. So a session launched in a non-plan mode that entered
 * plan mode LATER (Shift+Tab / `/plan`) never got the tool wired — the model was
 * told (by the plan-mode addendum) to call it, did, and got
 * "Unknown tool exit_plan_mode".
 *
 * The fix registers the tool RESIDENT (whenever the session supplied
 * `planExitControls` — top-level only) and gates ADVERTISEMENT per-turn on the
 * live mode in `query.ts`. These tests assert at the `messages.create` boundary
 * (the tool list the model actually sees) across a mid-session mode flip in both
 * directions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { PlanExitControls } from '../../types/config-types.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';

const messagesCreateMock = vi.fn();
class MockAnthropic {
  public messages = { create: messagesCreateMock };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', content: [],
        model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

async function drainQuery(query: AsyncIterable<unknown>): Promise<void> {
  for await (const _ev of query) { void _ev; }
}

function toolNamesOfCall(callIndex: number): string[] {
  const args = messagesCreateMock.mock.calls[callIndex]?.[0] as { tools?: unknown } | undefined;
  const tools = args?.tools;
  if (!Array.isArray(tools)) return [];
  return (tools as { name?: string }[]).map((t) => t.name ?? '').filter(Boolean);
}

const planExitControls: PlanExitControls = {
  setPermissionMode: async () => {},
  requestImplementSeed: () => {},
  getPrePlanMode: () => 'default',
};

describe('exit_plan_mode live advertisement (anthropic-direct)', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
  });

  it('started in plan mode → exit_plan_mode IS offered on turn 1', async () => {
    const provider = new AnthropicDirectProvider();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('t1')));
    const query = provider.query({
      prompt: (async function* () { yield { content: 't1' }; })(),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', permissionMode: 'plan', planExitControls },
    });
    await drainQuery(query as AsyncIterable<unknown>);
    expect(toolNamesOfCall(0)).toContain('exit_plan_mode');
  });

  it('started default, flipped to plan mid-session → exit_plan_mode IS offered on turn 2', async () => {
    const provider = new AnthropicDirectProvider();
    let flipResolver: (() => void) | null = null;
    const flip = new Promise<void>((r) => { flipResolver = r; });
    async function* twoInputs() { yield { content: 't1' }; await flip; yield { content: 't2' }; }
    const query = provider.query({
      prompt: twoInputs(),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', permissionMode: 'default', planExitControls },
    });
    let turnIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      turnIdx += 1;
      if (turnIdx === 1) {
        queueMicrotask(async () => { await query.setPermissionMode?.('plan'); flipResolver?.(); });
      }
      return fromArray(makeTextStream(`turn ${turnIdx}`));
    });
    await drainQuery(query as AsyncIterable<unknown>);
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
    // Turn 1 (default) must NOT offer it; turn 2 (plan) MUST — the regression.
    expect(toolNamesOfCall(0)).not.toContain('exit_plan_mode');
    expect(toolNamesOfCall(1)).toContain('exit_plan_mode');
  });

  it('started in plan, flipped to default mid-session → exit_plan_mode is NOT offered on turn 2', async () => {
    const provider = new AnthropicDirectProvider();
    let flipResolver: (() => void) | null = null;
    const flip = new Promise<void>((r) => { flipResolver = r; });
    async function* twoInputs() { yield { content: 't1' }; await flip; yield { content: 't2' }; }
    const query = provider.query({
      prompt: twoInputs(),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', permissionMode: 'plan', planExitControls },
    });
    let turnIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      turnIdx += 1;
      if (turnIdx === 1) {
        queueMicrotask(async () => { await query.setPermissionMode?.('default'); flipResolver?.(); });
      }
      return fromArray(makeTextStream(`turn ${turnIdx}`));
    });
    await drainQuery(query as AsyncIterable<unknown>);
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
    expect(toolNamesOfCall(0)).toContain('exit_plan_mode');
    expect(toolNamesOfCall(1)).not.toContain('exit_plan_mode');
  });

  it('subagent-style session (no planExitControls) never offers exit_plan_mode, even in plan', async () => {
    const provider = new AnthropicDirectProvider();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('t1')));
    const query = provider.query({
      prompt: (async function* () { yield { content: 't1' }; })(),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', permissionMode: 'plan' },
    });
    await drainQuery(query as AsyncIterable<unknown>);
    expect(toolNamesOfCall(0)).not.toContain('exit_plan_mode');
  });
});
