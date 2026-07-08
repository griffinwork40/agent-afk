/**
 * Regression test for AFK-mode GATE wiring (the enforcement half).
 *
 * `plan-mode-system-payload.test.ts` and `afk-mode-addendum.test.ts` cover the
 * POSTURE half — the system-prompt addendum the model sees. This file covers the
 * ENFORCEMENT half: when a session is in `'autonomous'` (AFK) permission mode,
 * a high-risk bash command such as `rm -rf x` must be REFUSED by the AFK-mode
 * gate before its handler runs.
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
 * `isError: true` with an "AFK mode" / "blocked by PreToolUse hook" message;
 * an un-gated call instead runs the real `bash` handler (which would execute
 * the command).
 *
 * Key difference from plan-mode gate wiring: the AFK gate applies TREE-WIDE
 * (no subagent self-skip for safety ceiling), and only `'autonomous'` mode
 * triggers it (not `'plan'` or `'default'`).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../provider.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { createHookRegistry, type HookRegistry } from '../../hooks.js';
import { createAfkModeGate } from '../../afk-mode-gate.js';
import type { ElicitationResult } from '../../types/sdk-types.js';

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

/**
 * Registry carrying ONLY the AFK-mode gate in the requested mode. The gate's
 * `route` is stubbed to DECLINE so high-risk ops immediately degrade to the
 * legacy hard block — this isolates the "gate fires and blocks" assertion from
 * the elicitation round-trip path tested in `afk-mode-gate.test.ts`.
 */
function afkGateRegistry(mode: 'autonomous' | 'default'): HookRegistry {
  const registry = createHookRegistry();
  registry.register(
    'PreToolUse',
    createAfkModeGate(
      () => mode,
      undefined,
      undefined,
      // Stub the elicitation route to DECLINE immediately so a high-risk op
      // degrades to a hard block without waiting for any operator response.
      { route: async (): Promise<ElicitationResult> => ({ action: 'decline' }) },
    ),
    { longRunning: true },
  );
  return registry;
}

const BASH_RM_INPUT = JSON.stringify({ command: 'rm -rf x' });

function toolOutputOf(events: ProviderEvent[]): { content: string; isError?: boolean } {
  const ev = events.find((e) => e.type === 'tool.output');
  if (!ev || ev.type !== 'tool.output') {
    throw new Error('expected a tool.output event');
  }
  return { content: ev.content, ...(ev.isError !== undefined ? { isError: ev.isError } : {}) };
}

describe('AnthropicDirectProvider — AFK-mode gate reaches the dispatcher via config.hookRegistry', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_bash', 'bash', BASH_RM_INPUT));
      }
      return fromArray(makeTextStream('done'));
    });
  });

  it('BLOCKS bash rm -rf for a top-level session in autonomous (AFK) mode', async () => {
    // Provider constructed WITHOUT a hookRegistry — exactly how bootstrap.ts,
    // chat.ts, daemon.ts, and telegram.ts build it. The gate must still fire
    // because the session-scoped registry is supplied on the query config.
    const provider = new AnthropicDirectProvider({
      permissions: { allowedTools: ['bash'] },
    });
    const query = provider.query({
      prompt: singleInput('remove the build dir'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'autonomous',
        hookRegistry: afkGateRegistry('autonomous'),
      },
    });

    const events = await collect(query);
    const out = toolOutputOf(events);

    expect(out.isError).toBe(true);
    expect(out.content).toContain('AFK mode');
    expect(out.content).toContain('bash');
  });

  it('does NOT block bash rm -rf when the session is in default mode', async () => {
    // In default mode the AFK gate is a no-op — only 'autonomous' triggers it.
    const provider = new AnthropicDirectProvider({
      permissions: { allowedTools: ['bash'] },
    });
    const query = provider.query({
      prompt: singleInput('remove the build dir'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'default',
        hookRegistry: afkGateRegistry('default'),
      },
    });

    const events = await collect(query);
    const out = toolOutputOf(events);

    // The gate did not fire — whatever the handler returned, it is NOT the
    // AFK-mode refusal.
    expect(out.content).not.toContain('AFK mode');
    expect(out.content).not.toContain('blocked by PreToolUse hook');
  });
});
