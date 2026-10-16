/**
 * #3839: idle Telegram session wake when a background subagent settles.
 *
 * Verifies that `TelegramBgResultNotifier.onInjectable` is called when a
 * non-cancelled job settles, and that `MessageHandler.wakeIdleSession` fires
 * a synthetic auto-resume turn only when the session is idle and unclaimed.
 *
 * Harness mirrors message-bg-injection.test.ts: streamResponse and
 * registerChatCommands are mocked; we inspect calls on the mock.
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
import type { SessionManager } from '../session-manager.js';

/** Minimal SessionManager stub; session state is controlled by tests. */
function makeSessionManager(state: 'idle' | 'streaming' = 'idle'): SessionManager {
  return {
    getSession: vi.fn().mockResolvedValue({
      state,
      sessionId: 'idle-wake-test-session',
      waitForInitialization: vi.fn().mockResolvedValue({ sessionId: 'idle-wake-test-session' }),
    }),
    getSessionIfExists: vi.fn().mockReturnValue(
      state === 'idle'
        ? undefined // no existing session — definitely idle
        : { state, sessionId: 'busy-session' },
    ),
    resetSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeHandler(sessionManager: SessionManager): MessageHandler {
  const bot = { telegram: { sendMessage: vi.fn() }, command: vi.fn(), on: vi.fn() };
  return new MessageHandler(
    bot as unknown as import('telegraf').Telegraf,
    sessionManager,
    new Set<number>(),
    vi.fn(),
    new Set<number>(),
  );
}

/** Register and immediately settle a background job as succeeded. */
function settleJob(registry: BackgroundAgentRegistry, content = 'result'): string {
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
  const job = registry.register({ handle, prompt: 'bg task', model: 'sonnet' });
  onTerminal?.({
    id: job.jobId,
    status: 'succeeded',
    message: { content, role: 'assistant' },
  } as unknown as SubagentResult);
  return job.jobId;
}

describe('TelegramBgResultNotifier — onInjectable hook (#3839)', () => {
  let registry: BackgroundAgentRegistry;
  let notifier: TelegramBgResultNotifier;

  beforeEach(() => {
    registry = new BackgroundAgentRegistry({});
    notifier = new TelegramBgResultNotifier(registry, 4242);
  });
  afterEach(() => { notifier.dispose(); });

  it('calls onInjectable after a non-cancelled job settles', () => {
    const wake = vi.fn();
    notifier.onInjectable = wake;

    settleJob(registry, 'output');

    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onInjectable for cancelled jobs', async () => {
    const wake = vi.fn();
    notifier.onInjectable = wake;

    const handle = {
      id: 'sub-cancel',
      status: 'idle',
      runInBackground: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
      runToResult: vi.fn(),
    } as unknown as SubagentHandle;
    registry.register({ handle, prompt: 'cancel me', model: 'sonnet' });
    await registry.cancelAll();

    expect(wake).not.toHaveBeenCalled();
  });

  it('fires onInjectable AFTER pendingInjections is populated', () => {
    let hasPending = false;
    notifier.onInjectable = () => { hasPending = notifier.hasPendingInjections(); };

    settleJob(registry, 'data');

    expect(hasPending).toBe(true);
  });

  it('does NOT call onInjectable after dispose()', () => {
    const wake = vi.fn();
    notifier.onInjectable = wake;
    notifier.dispose();

    settleJob(registry, 'too late');

    expect(wake).not.toHaveBeenCalled();
  });
});

describe('MessageHandler.wakeIdleSession (#3839)', () => {
  beforeEach(() => { mockStreamResponse.mockClear(); });

  it('fires a synthetic turn when session is idle and unclaimed', async () => {
    const sm = makeSessionManager('idle');
    const handler = makeHandler(sm);
    const registry = new BackgroundAgentRegistry({});
    const notifier = new TelegramBgResultNotifier(registry, 7777);
    notifier.onInjectable = () => { handler.wakeIdleSession({ chatId: 7777 }); };

    const jobId = settleJob(registry, 'background result');

    // Allow the synthetic turn to run.
    await vi.waitFor(() => expect(mockStreamResponse).toHaveBeenCalledTimes(1));

    const content = mockStreamResponse.mock.calls[0]![2] as string;
    // Synthetic turn content is the auto-resume directive (not a user message).
    expect(content).toContain('[auto-resume]');
    // bg-injection prepends the envelope ahead of the directive.
    expect(content).toContain(`background-subagent-result jobId="${jobId}"`);

    notifier.dispose();
  });

  it('does NOT fire a synthetic turn when a turn is in flight (claimed)', async () => {
    const sm = makeSessionManager('idle');
    const handler = makeHandler(sm);
    const registry = new BackgroundAgentRegistry({});
    const notifier = new TelegramBgResultNotifier(registry, 8888);

    // Simulate a claimed slot by starting a real turn first.
    // We use a long-running mock to keep the claim held.
    let releaseTurn!: () => void;
    mockStreamResponse.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseTurn = resolve; }),
    );

    // Start a turn that claims the slot.
    const route = { chatId: 8888 };
    handler.wakeIdleSession(route); // first wake — claims slot
    await vi.waitFor(() => expect(mockStreamResponse).toHaveBeenCalledTimes(1));

    // Now wire onInjectable and settle a job — slot is still claimed.
    notifier.onInjectable = () => { handler.wakeIdleSession(route); };
    settleJob(registry, 'while busy');

    // Second wake must be blocked by the claimed slot.
    expect(mockStreamResponse).toHaveBeenCalledTimes(1);

    releaseTurn();
    notifier.dispose();
  });

  it('does NOT fire when the session is busy (streaming)', () => {
    const sm = makeSessionManager('streaming');
    const handler = makeHandler(sm);

    handler.wakeIdleSession({ chatId: 9999 });

    expect(mockStreamResponse).not.toHaveBeenCalled();
  });

  it('does NOT fire when messages are already queued', async () => {
    const sm = makeSessionManager('streaming'); // session busy so we can enqueue
    const handler = makeHandler(sm);

    // Enqueue a real message by sending to a busy session.
    const textCtx = {
      chat: { id: 1111, type: 'private' as const },
      message: { text: 'hello', from: { id: 1111, first_name: 'Op' } },
      botInfo: { id: 42, username: 'Bot' },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => ({})),
      sendChatAction: vi.fn(async () => {}),
    } as unknown as Context;
    await handler.handle(textCtx);
    // Message is now queued; reset call count.
    mockStreamResponse.mockClear();

    // Switch session to idle for the wake check, but the queue is non-empty.
    // Stub getSessionIfExists to return idle but leave the queue intact.
    (sm.getSessionIfExists as ReturnType<typeof vi.fn>).mockReturnValue({ state: 'idle', sessionId: 's' });

    handler.wakeIdleSession({ chatId: 1111 });
    expect(mockStreamResponse).not.toHaveBeenCalled();
  });
});
