/**
 * Integration test for plan-mode system-payload injection.
 *
 * Verifies that when the session is in `'plan'` permission mode, the system
 * payload passed to `messages.create` includes the plan-mode addendum text,
 * and when it is not in plan mode the addendum is absent. The check is at
 * the `messages.create` boundary — the closest observable point to what the
 * model actually sees.
 *
 * Pattern: mocked Anthropic Messages-API client factory (mirrors
 * `query-auth-retry.test.ts`) — agent-afk uses `@anthropic-ai/sdk`
 * directly via the `anthropic-direct` provider, so we intercept at the
 * `messages.create` boundary, capture the `system` argument from the
 * call site, and assert on its content.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from './index.js';
import { PLAN_MODE_ADDENDUM_TEXT } from './plan-mode-addendum.js';

// --- Mock Anthropic Messages-API plumbing (mirrors query-auth-retry.test.ts) ---

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(
    () => new MockAnthropic() as unknown as Anthropic,
  );
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** Minimal end-of-turn stream. */
function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5-20250929',
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
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function extractSystemText(systemArg: unknown): string {
  if (typeof systemArg === 'string') return systemArg;
  if (!Array.isArray(systemArg)) return '';
  const blocks = systemArg as ContentBlockParam[];
  return blocks
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

async function drainQuery(
  query: AsyncIterable<unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ev of query) {
    // drain
  }
}

describe('AnthropicDirectQuery — plan-mode system payload', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() =>
      fromArray(makeTextStream('ok')),
    );
  });

  it('omits the plan-mode addendum when permission mode is default', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-4-5-20250929',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'default',
      },
    });

    await drainQuery(query);

    expect(messagesCreateMock).toHaveBeenCalled();
    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);
    // Sentinel from the addendum text — must not appear in default mode.
    expect(text).not.toContain('Plan mode is active');
    expect(text).not.toContain(PLAN_MODE_ADDENDUM_TEXT);
  });

  it('omits the plan-mode addendum when permission mode is unset', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-4-5-20250929',
        apiKey: 'sk-ant-oat01-test',
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);
    expect(text).not.toContain('Plan mode is active');
  });

  it('includes the plan-mode addendum when permission mode is plan', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-4-5-20250929',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'plan',
      },
    });

    await drainQuery(query);

    expect(messagesCreateMock).toHaveBeenCalled();
    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);
    expect(text).toContain(PLAN_MODE_ADDENDUM_TEXT);
    // Spot-check the topology + skill names made it through.
    expect(text).toContain('ground-state');
    expect(text).toContain('devils-advocate');
  });

  it('appends the addendum as the LAST system block (cache breakpoint position)', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-4-5-20250929',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'plan',
        systemPrompt: 'Some user-provided system prompt.',
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    expect(Array.isArray(systemArg)).toBe(true);
    const blocks = systemArg as ContentBlockParam[];
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const last = blocks[blocks.length - 1]!;
    // Last block is the addendum (text block carrying the addendum text).
    expect(last.type).toBe('text');
    expect(
      last.type === 'text' && typeof last.text === 'string'
        ? last.text
        : '',
    ).toContain('Plan mode is active');

    // The cache breakpoint stamper, when caching is on, lands the ephemeral
    // marker on this last block. We don't assert on cache_control here
    // because cache state depends on env; the key invariant is *position*.
    // The cache-policy tests own the marker-stamping invariant.
  });

  it('reflects a mid-session setPermissionMode flip on the NEXT turn', async () => {
    // Simulate: start in default, run one turn, flip to plan, run a second
    // turn. The first turn's system must NOT contain the addendum; the
    // second turn's system MUST contain it.
    const provider = new AnthropicDirectProvider();

    async function* twoInputs(): AsyncIterable<{ content: string }> {
      yield { content: 'turn 1' };
      // Flip plan mode between turns via the query handle. The handle is
      // captured below; tests in this file iterate the query, so we resolve
      // a deferred toggle keyed off seeing the first turn complete.
      await flipBetweenTurns;
      yield { content: 'turn 2' };
    }

    let flipResolver: (() => void) | null = null;
    const flipBetweenTurns = new Promise<void>((resolve) => {
      flipResolver = resolve;
    });

    const query = provider.query({
      prompt: twoInputs(),
      config: {
        model: 'claude-sonnet-4-5-20250929',
        apiKey: 'sk-ant-oat01-test',
        permissionMode: 'default',
      },
    });

    // Resolve the flip after the first messages.create call completes by
    // wiring a one-shot side effect.
    let turnIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      turnIdx += 1;
      if (turnIdx === 1) {
        // After turn 1's stream resolves, flip the mode and unblock the
        // second input.
        queueMicrotask(async () => {
          await query.setPermissionMode?.('plan');
          flipResolver?.();
        });
      }
      return fromArray(makeTextStream(`turn ${turnIdx}`));
    });

    await drainQuery(query);

    expect(messagesCreateMock).toHaveBeenCalledTimes(2);

    const turn1Text = extractSystemText(
      (messagesCreateMock.mock.calls[0]![0] as { system?: unknown }).system,
    );
    const turn2Text = extractSystemText(
      (messagesCreateMock.mock.calls[1]![0] as { system?: unknown }).system,
    );

    expect(turn1Text).not.toContain('Plan mode is active');
    expect(turn2Text).toContain('Plan mode is active');
  });
});
