/**
 * Regression test for plan-mode GATE wiring (the enforcement half).
 *
 * `plan-mode-system-payload.test.ts` covers the POSTURE half — the system
 * prompt addendum the model sees. This file covers the ENFORCEMENT half: when
 * a session is in `'plan'` permission mode, a write-class tool such as
 * `edit_file` must be REFUSED by the plan-mode gate before its handler runs.
 *
 * The gate is a `PreToolUse` hook. It reaches the per-query
 * `SessionToolDispatcher` only if the provider threads the session's hook
 * registry into the dispatcher. Production entry points (REPL/chat/daemon/
 * telegram) construct the provider WITHOUT a constructor-time `hookRegistry`
 * and instead pass the session-scoped registry on `AgentConfig.hookRegistry`
 * (consumed by `provider.query({ config })`). This test mirrors that exact
 * shape — `new AnthropicDirectProvider()` (no constructor registry) + a
 * registry supplied on the query config — so a regression that drops
 * `config.hookRegistry` on the dispatcher path is caught here.
 *
 * Observation point: the `tool.output` ProviderEvent. A gate block surfaces as
 * `isError: true` with a "plan mode … refused" / "blocked by PreToolUse hook"
 * message; an un-gated call instead runs the real `edit_file` handler.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../provider.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { createHookRegistry, type HookRegistry } from '../../hooks.js';
import { createPlanModeGate } from '../../plan-mode-gate.js';

// --- Mock Anthropic Messages-API plumbing (mirrors plan-mode-system-payload.test.ts) ---

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

function makeToolUseStream(
  toolId: string,
  toolName: string,
  inputJson: string,
): RawMessageStreamEvent[] {
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

/** Registry carrying ONLY the plan-mode gate, in the requested mode. */
function planGateRegistry(mode: 'plan' | 'default'): HookRegistry {
  const registry = createHookRegistry();
  registry.register('PreToolUse', createPlanModeGate(() => mode));
  return registry;
}

const EDIT_FILE_INPUT = JSON.stringify({
  file_path: '/tmp/afk-plan-mode-gate-wiring-nonexistent.txt',
  old_string: 'a',
  new_string: 'b',
});

function toolOutputOf(events: ProviderEvent[]): { content: string; isError?: boolean } {
  const ev = events.find((e) => e.type === 'tool.output');
  if (!ev || ev.type !== 'tool.output') {
    throw new Error('expected a tool.output event');
  }
  return { content: ev.content, ...(ev.isError !== undefined ? { isError: ev.isError } : {}) };
}

describe('AnthropicDirectProvider — plan-mode gate reaches the dispatcher via config.hookRegistry', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_edit', 'edit_file', EDIT_FILE_INPUT));
      }
      return fromArray(makeTextStream('done'));
    });
  });

  it('BLOCKS edit_file for a top-level session in plan mode', async () => {
    // Provider constructed WITHOUT a hookRegistry — exactly how bootstrap.ts,
    // chat.ts, daemon.ts, and telegram.ts build it. The gate must still fire
    // because the session-scoped registry is supplied on the query config.
    const provider = new AnthropicDirectProvider({
      permissions: { allowedTools: ['edit_file'] },
    });
    const query = provider.query({
      prompt: singleInput('edit the file'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'plan',
        hookRegistry: planGateRegistry('plan'),
      },
    });

    const events = await collect(query);
    const out = toolOutputOf(events);

    expect(out.isError).toBe(true);
    expect(out.content).toContain('plan mode');
    expect(out.content).toContain('edit_file');
  });

  it('does NOT block edit_file for a forked subagent in plan mode (parentSessionId self-skip)', async () => {
    // A subagent inherits the parent registry but its tool calls are task
    // output, not main-conversation mutations — the gate self-skips when
    // parentSessionId is set. This guards against the fix over-blocking.
    const provider = new AnthropicDirectProvider({
      permissions: { allowedTools: ['edit_file'] },
    });
    const query = provider.query({
      prompt: singleInput('edit the file'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'plan',
        parentSessionId: 'parent-session-123',
        hookRegistry: planGateRegistry('plan'),
      },
    });

    const events = await collect(query);
    const out = toolOutputOf(events);

    // The gate did not fire — whatever the handler returned, it is NOT the
    // plan-mode refusal.
    expect(out.content).not.toContain('plan mode');
    expect(out.content).not.toContain('blocked by PreToolUse hook');
  });

  it('does NOT block edit_file when the session is in default mode', async () => {
    const provider = new AnthropicDirectProvider({
      permissions: { allowedTools: ['edit_file'] },
    });
    const query = provider.query({
      prompt: singleInput('edit the file'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'default',
        hookRegistry: planGateRegistry('default'),
      },
    });

    const events = await collect(query);
    const out = toolOutputOf(events);

    expect(out.content).not.toContain('plan mode');
    expect(out.content).not.toContain('blocked by PreToolUse hook');
  });
});
