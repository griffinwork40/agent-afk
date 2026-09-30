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
import { drainBgInjections, prependToContent, registerBgInjectionSource, unregisterBgInjectionSource } from './bg-injection.js';

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

  it('pushes a notification when a background job completes', async () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'investigate something',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'found the answer'));

    // Push is deferred via queueMicrotask — wait for it.
    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    const text = pushMock.mock.calls[0]![0];
    expect(text).toContain('✅');
    expect(text).toContain('completed');
    expect(text).toContain('investigate something');
  });

  it('pushes a notification when a background job fails', async () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'research task',
      model: 'sonnet',
    });

    fireTerminal(fail(job.jobId, 'rate limit'));

    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
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

  it('targets a specific chat when chatId is provided', async () => {
    notifier.dispose();
    notifier = new TelegramBgResultNotifier(registry, 12345);

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'targeted task',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'done'));

    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    const opts = pushMock.mock.calls[0]![1];
    expect(opts).toEqual({ target: 12345 });
  });

  it('passes messageThreadId when threadId is provided', async () => {
    notifier.dispose();
    notifier = new TelegramBgResultNotifier(registry, 12345, 77);

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'topic task',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'done'));

    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    const opts = pushMock.mock.calls[0]![1];
    expect(opts).toEqual({ target: 12345, messageThreadId: 77 });
  });

  it('uses default notify routing when no chatId is provided', async () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'default routing task',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'done'));

    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    const opts = pushMock.mock.calls[0]![1];
    expect(opts).toEqual({ target: undefined });
  });

  it('stops pushing when dispose() is called before the settled event', async () => {
    notifier.dispose();

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'after dispose',
      model: 'sonnet',
    });

    fireTerminal(succeed(job.jobId, 'done'));

    // Let the microtask queue drain to confirm no deferred push fires either.
    await new Promise<void>((r) => queueMicrotask(r));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not push when settled and dispose() happen in the same synchronous frame', async () => {
    // This exercises the dispose-race window: onSettled enqueues a
    // queueMicrotask push, then dispose() runs — both in the same synchronous
    // frame before the microtask has a chance to execute. Without the
    // `disposed` guard the push would still fire after teardown.
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({
      handle,
      prompt: 'settled then dispose',
      model: 'sonnet',
    });

    // Both calls are synchronous — fireTerminal enqueues the microtask,
    // dispose() sets the disposed flag, all before the microtask runs.
    fireTerminal(succeed(job.jobId, 'done'));
    notifier.dispose();

    // Drain the microtask queue — the guarded body must not call push.
    await new Promise<void>((r) => queueMicrotask(r));
    expect(pushMock).not.toHaveBeenCalled();
    // dispose() clears pendingInjections, so drainInjections() must return ''
    // (the job was never injected because dispose ran before the guard-free
    // pendingInjections.push path could fire).
    expect(notifier.drainInjections()).toBe('');
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

  // ── #2364: result body delivery + next-turn injection ─────────────────────

  it('includes the result body in the push after the status line', async () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'body task', model: 'sonnet' });

    fireTerminal(succeed(job.jobId, 'FINDING: the cache key is stale'));

    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    const text = pushMock.mock.calls[0]![0];
    const [header, ...rest] = text.split('\n\n');
    expect(header).toContain('Background task completed: body task');
    expect(rest.join('\n\n')).toBe('FINDING: the cache key is stale');
  });

  it('includes the failure reason in the push for a failed job', async () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'failing task', model: 'sonnet' });

    fireTerminal(fail(job.jobId, 'rate limit'));

    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock.mock.calls[0]![0]).toContain('rate limit');
  });

  it('caps a >16KB body with a /bgsub:join marker naming the job', async () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'huge task', model: 'sonnet' });

    fireTerminal(succeed(job.jobId, 'x'.repeat(40_000)));

    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    const text = pushMock.mock.calls[0]![0];
    expect(text).toContain(`full result via /bgsub:join ${job.jobId}`);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(17 * 1024);
  });

  it('buffers the result for next-turn injection and drains it exactly once', () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'inject task', model: 'sonnet' });
    const delivered = vi.spyOn(registry, 'markDelivered');

    fireTerminal(succeed(job.jobId, 'injected <b>finding</b>'));

    const first = notifier.drainInjections();
    expect(first).toContain(`<background-subagent-result jobId="${job.jobId}" status="completed"`);
    expect(first).toContain('injected &lt;b&gt;finding&lt;/b&gt;');
    expect(delivered).toHaveBeenCalledWith(job.jobId);
    expect(notifier.drainInjections()).toBe('');
  });

  it('does not buffer cancelled jobs for injection', async () => {
    const { handle } = makeBgHandle();
    registry.register({ handle, prompt: 'cancel me', model: 'sonnet' });
    await registry.cancelAll();
    expect(notifier.drainInjections()).toBe('');
  });

  it('routes injections to the owning chat/topic only', () => {
    notifier.dispose();
    notifier = new TelegramBgResultNotifier(registry, 555, 9);

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'routed task', model: 'sonnet' });
    fireTerminal(succeed(job.jobId, 'routed result'));

    expect(drainBgInjections('555')).toBe('');
    expect(drainBgInjections('556:9')).toBe('');
    expect(drainBgInjections('555:9')).toContain('routed result');
    expect(drainBgInjections('555:9')).toBe('');
  });

  it('unregisters its route on dispose without evicting a replacement', () => {
    notifier.dispose();
    const old = new TelegramBgResultNotifier(registry, 777);
    const replacement = new TelegramBgResultNotifier(new BackgroundAgentRegistry({}), 777);
    old.dispose();
    notifier = replacement;

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'old session', model: 'sonnet' });
    fireTerminal(succeed(job.jobId, 'from disposed session'));

    // Old notifier is unsubscribed; replacement is still the route's source.
    expect(drainBgInjections('777')).toBe('');
    replacement.dispose();
    expect(drainBgInjections('777')).toBe('');
  });

  // ── #2380: dispose() must markDelivered for buffered-but-undrained jobs ────

  it('calls markDelivered for buffered jobs when dispose() is called without draining', () => {
    const markDelivered = vi.spyOn(registry, 'markDelivered');

    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'undrained task', model: 'sonnet' });

    // Push the job into pendingInjections by firing a non-cancelled settle.
    fireTerminal(succeed(job.jobId, 'result that will never be drained'));

    // Do NOT call drainInjections() — simulate session teardown where drain
    // is never reached.
    notifier.dispose();

    // dispose() must account for the buffered job via markDelivered.
    expect(markDelivered).toHaveBeenCalledWith(job.jobId);
  });
});

describe('prependToContent', () => {
  it('returns content unchanged when there is nothing to inject', () => {
    const blocks = [{ type: 'text' as const, text: 'hi' }];
    expect(prependToContent('', 'hello')).toBe('hello');
    expect(prependToContent('', blocks)).toBe(blocks);
  });

  it('concatenates onto string content', () => {
    expect(prependToContent('<r/>\n', 'hello')).toBe('<r/>\nhello');
  });

  it('prepends a text block to content-block arrays, leaving others intact', () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AA' } };
    const out = prependToContent('<r/>\n', [image]);
    expect(out).toEqual([{ type: 'text', text: '<r/>\n' }, image]);
  });
});

// ── #2398: warn on stale-source overwrite in registerBgInjectionSource ────────

describe('registerBgInjectionSource', () => {
  const testKey = '__test_route_warn__';
  const stubSource = { drainInjections: () => '' };

  afterEach(() => {
    // Clean up any registrations this suite made.
    unregisterBgInjectionSource(testKey, stubSource);
  });

  it('does not warn on first registration for a key', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerBgInjectionSource(testKey, stubSource);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns when a second registration overwrites an existing key (stale-session signal)', () => {
    registerBgInjectionSource(testKey, stubSource);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replacement = { drainInjections: () => '' };
    registerBgInjectionSource(testKey, replacement);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain(testKey);
    warnSpy.mockRestore();
    // Clean up the replacement (stubSource was replaced so won't self-evict).
    unregisterBgInjectionSource(testKey, replacement);
  });
});

// ── #2398: deferred body formatting — push happens async, not on the event ───
//    loop synchronously during onSettled

describe('TelegramBgResultNotifier — deferred push formatting', () => {
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

  it('does not invoke pushIfConfigured synchronously during the settled event', () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'deferred task', model: 'sonnet' });

    // fireTerminal is synchronous; if push is deferred (via queueMicrotask)
    // then pushIfConfigured must not have been called yet at this point.
    fireTerminal(succeed(job.jobId, 'result'));

    // Push call count must still be 0 synchronously — formatting is deferred.
    expect(pushMock).toHaveBeenCalledTimes(0);
  });

  it('eventually invokes pushIfConfigured after the microtask queue drains', async () => {
    const { handle, fireTerminal } = makeBgHandle();
    const job = registry.register({ handle, prompt: 'deferred body task', model: 'sonnet' });

    fireTerminal(succeed(job.jobId, 'deferred body'));

    // Allow the queueMicrotask callback to run.
    await vi.waitFor(() => {
      expect(pushMock).toHaveBeenCalledTimes(1);
    });

    const text = pushMock.mock.calls[0]![0];
    expect(text).toContain('deferred body');
  });
});
