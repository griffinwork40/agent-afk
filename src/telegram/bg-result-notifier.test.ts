/**
 * Tests for `TelegramBgResultNotifier` — push notification for settled
 * background subagent jobs on the Telegram surface.
 *
 * Uses the real `BackgroundAgentRegistry`; jobs are driven to terminal states
 * via a stubbed `SubagentHandle` (same harness as the REPL's
 * bg-result-notifier.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BackgroundAgentRegistry } from '../agent/background-registry.js';
import type { SubagentHandle, SubagentResult } from '../agent/subagent.js';
import { TelegramBgResultNotifier } from './bg-result-notifier.js';

// Stub pushIfConfigured so we can observe calls without hitting the network.
vi.mock('./push.js', () => ({
  pushIfConfigured: vi.fn(async () => []),
}));

// Silence routing telemetry writes (background-registry emits them on settle).
vi.mock('../agent/routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn(async () => {}),
}));

import { pushIfConfigured } from './push.js';

const pushMock = vi.mocked(pushIfConfigured);

/** Stub a `SubagentHandle` whose `runInBackground` callback we control. */
function makeBgHandle(id = 'sub-1'): {
  handle: SubagentHandle;
  fireTerminal: (r: SubagentResult) => void;
} {
  let captured: ((r: SubagentResult) => void) | undefined;
  return {
    handle: {
      id,
      status: 'idle',
      runInBackground: vi.fn((_p: string, on?: (r: SubagentResult) => void) => {
        captured = on;
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
      runToResult: vi.fn(),
    } as unknown as SubagentHandle,
    fireTerminal: (r) => captured?.(r),
  };
}

function succeed(id: string, content: string): SubagentResult {
  return {
    id,
    status: 'succeeded',
    message: { content, role: 'assistant' } as unknown as SubagentResult['message'],
  } as SubagentResult;
}

function fail(id: string, msg: string): SubagentResult {
  return {
    id,
    status: 'failed',
    error: new Error(msg),
  } as SubagentResult;
}

describe('TelegramBgResultNotifier', () => {
  let registry: BackgroundAgentRegistry;
  let notifier: TelegramBgResultNotifier;

  beforeEach(() => {
    registry = new BackgroundAgentRegistry({});
    notifier = new TelegramBgResultNotifier(registry);
    pushMock.mockClear();
  });

  afterEach(() => {
    notifier.dispose();
  });

  it('pushes a notification when a background job completes', () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'investigate something',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'found the answer'));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const text = pushMock.mock.calls[0]![0];
    expect(text).toContain('✅');
    expect(text).toContain('completed');
    expect(text).toContain('investigate something');
  });

  it('pushes a notification when a background job fails', () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'research task',
      model: 'sonnet',
    });

    fireTerminal(fail(job.jobId, 'rate limit'));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const text = pushMock.mock.calls[0]![0];
    expect(text).toContain('❌');
    expect(text).toContain('failed');
  });

  it('skips cancelled jobs', async () => {
    const { handle } = makeBgHandle();
    registry.register({
      handle,
      prompt: 'will be cancelled',
      model: 'sonnet',
    });

    // Cancel triggers the settled event with status='cancelled'.
    await registry.cancelAll();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('targets a specific chat when chatId is provided', () => {
    notifier.dispose();
    notifier = new TelegramBgResultNotifier(registry, 12345);

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'targeted task',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'done'));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const opts = pushMock.mock.calls[0]![1];
    expect(opts).toEqual({ target: 12345 });
  });

  it('passes messageThreadId when threadId is provided', () => {
    notifier.dispose();
    notifier = new TelegramBgResultNotifier(registry, 12345, 77);

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'topic task',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'done'));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const opts = pushMock.mock.calls[0]![1];
    expect(opts).toEqual({ target: 12345, messageThreadId: 77 });
  });

  it('uses default notify routing when no chatId is provided', () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'default routing task',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'done'));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const opts = pushMock.mock.calls[0]![1];
    expect(opts).toEqual({ target: undefined });
  });

  it('stops pushing after dispose', () => {
    notifier.dispose();

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'after dispose',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'done'));

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('swallows push errors without throwing', async () => {
    pushMock.mockRejectedValueOnce(new Error('network failure'));

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'push will fail',
      model: 'sonnet',
    });

    // fireTerminal is sync; the push rejection is async.
    fireTerminal(succeed(job.jobId, 'done'));
    // Drain microtask queue — if .catch() were missing, an unhandled
    // rejection would surface here.
    await vi.waitFor(() => {
      expect(pushMock).toHaveBeenCalledTimes(1);
    });
  });
});
