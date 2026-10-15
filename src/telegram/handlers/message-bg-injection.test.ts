/**
 * Wire-through test (#2364): a background subagent result that settled on a
 * Telegram session is injected into that chat's NEXT turn — the content handed
 * to streamResponse starts with the `<background-subagent-result>` envelope —
 * and is delivered exactly once.
 *
 * Harness mirrors message-attribution.test.ts: streamResponse and
 * registerChatCommands are mocked; content is read off the mock's calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'telegraf';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

const { mockStreamResponse } = vi.hoisted(() => ({
  mockStreamResponse: vi.fn<
    [Context, unknown, string | ContentBlockParam[], ...unknown[]],
    Promise<void>
  >(async () => { /* no-op */ }),
}));

vi.mock('../streaming.js', () => ({ streamResponse: mockStreamResponse }));
vi.mock('./registration.js', () => ({ registerChatCommands: vi.fn(async () => { /* no-op */ }) }));
vi.mock('../push.js', () => ({ pushIfConfigured: vi.fn(async () => []) }));
vi.mock('../../agent/routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn(async () => {}) }));

import { MessageHandler } from './message.js';
import { BackgroundAgentRegistry } from '../../agent/background-registry.js';
import type { SubagentHandle, SubagentResult } from '../../agent/subagent.js';
import { TelegramBgResultNotifier } from '../bg-result-notifier.js';

function makeHandler(): MessageHandler {
  const sessionManager = {
    getSession: vi.fn().mockResolvedValue({
      state: 'idle',
      sessionId: 'bg-injection-test-session',
      waitForInitialization: vi.fn().mockResolvedValue({ sessionId: 'bg-injection-test-session' }),
    }),
    getSessionIfExists: vi.fn().mockReturnValue(undefined),
    resetSession: vi.fn(),
  };
  const bot = { telegram: { sendMessage: vi.fn() }, command: vi.fn(), on: vi.fn() };
  return new MessageHandler(
    bot as unknown as import('telegraf').Telegraf,
    sessionManager as unknown as import('../session-manager.js').SessionManager,
    new Set<number>(),
    vi.fn(),
    new Set<number>(),
  );
}

function makeTextCtx(chatId: number, text: string): Context {
  return {
    chat: { id: chatId, type: 'private' },
    message: { text, from: { id: chatId, first_name: 'Op' } },
    botInfo: { id: 42, username: 'Bot' },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
  } as unknown as Context;
}

/** Register a background job and settle it as succeeded with `content`. */
function settleJob(registry: BackgroundAgentRegistry, content: string): string {
  let onTerminal: ((r: SubagentResult) => void) | undefined;
  const handle = {
    id: 'sub-1',
    status: 'idle',
    runInBackground: vi.fn((_p: string, on?: (r: SubagentResult) => void) => { onTerminal = on; }),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(),
    runToResult: vi.fn(),
  } as unknown as SubagentHandle;
  const job = registry.register({ handle, prompt: 'bg investigation', model: 'sonnet' });
  onTerminal?.({
    id: job.jobId,
    status: 'succeeded',
    message: { content, role: 'assistant' },
  } as unknown as SubagentResult);
  return job.jobId;
}

describe('background result injection — MessageHandler next turn', () => {
  let registry: BackgroundAgentRegistry;
  let notifier: TelegramBgResultNotifier;

  beforeEach(() => {
    mockStreamResponse.mockClear();
    registry = new BackgroundAgentRegistry({});
    notifier = new TelegramBgResultNotifier(registry, 4242);
  });

  afterEach(() => { notifier.dispose(); });

  it('prepends the settled result to the next turn, then stops', async () => {
    const handler = makeHandler();
    const jobId = settleJob(registry, 'ROOT CAUSE: stale cache key');

    await handler.handle(makeTextCtx(4242, 'what did you find?'));
    const first = mockStreamResponse.mock.calls[0]![2] as string;
    expect(first.startsWith(`<background-subagent-result jobId="${jobId}"`)).toBe(true);
    expect(first).toContain('ROOT CAUSE: stale cache key');
    expect(first).toContain('what did you find?');

    await handler.handle(makeTextCtx(4242, 'thanks'));
    const second = mockStreamResponse.mock.calls[1]![2] as string;
    expect(second).not.toContain('background-subagent-result');
  });

  it('does not leak another chat\'s result into this chat', async () => {
    const handler = makeHandler();
    settleJob(registry, 'private to chat 4242');

    await handler.handle(makeTextCtx(9999, 'hello'));
    const content = mockStreamResponse.mock.calls[0]![2] as string;
    expect(content).not.toContain('background-subagent-result');
  });
});
