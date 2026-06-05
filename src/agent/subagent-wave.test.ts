/**
 * Tests for `runWave` — the parallel subagent fan-out helper that replaces
 * ad-hoc `Promise.all(handles.map(h => h.runToResult(...)))` patterns in
 * skill handlers.
 *
 * Verifies: no short-circuit on partial failure, fail-fast cancels peers,
 * teardown fires SubagentStop for every handle, aggregate results survive.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHookRegistry } from './hooks.js';
import type { HookContext } from './hooks.js';
import type { Message } from './types.js';

interface SessionState {
  config: Record<string, unknown>;
  replyDelayMs: number;
  replyContent: string | ((prompt: string) => string);
}

interface MockSessionTracker {
  state: SessionState;
  sendMessage: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const shared = vi.hoisted(() => ({
  sessions: [] as Array<MockSessionTracker>,
}));

vi.mock('./session.js', () => {
  class MockAgentSession {
    public readonly sessionId?: string;
    private readonly state: SessionState;
    public sendMessage: ReturnType<typeof vi.fn>;
    public sendMessageStream: ReturnType<typeof vi.fn>;
    public interrupt = vi.fn(async () => undefined);
    public close = vi.fn(async () => undefined);
    private mockInputStreamMessages: string[] = [];

    constructor(config: Record<string, unknown>) {
      this.sessionId = (config.sessionId as string | undefined) ?? 'child-session-id';
      this.state = { config, replyContent: '', replyDelayMs: 0 };
      this.sendMessage = vi.fn(async (content: string): Promise<Message> => {
        if (this.state.replyDelayMs > 0) {
          // Respect the session's abortSignal so a cancel() during delay
          // propagates through runToResult as a rejection (matches real SDK
          // behavior where query() is abortable).
          const signal = this.abortSignal;
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error('aborted'));
              return;
            }
            const timer = setTimeout(resolve, this.state.replyDelayMs);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
        }
        const reply =
          typeof this.state.replyContent === 'function'
            ? this.state.replyContent(content)
            : this.state.replyContent || `ok:${content}`;
        return { role: 'assistant', content: reply, timestamp: new Date() };
      });
      // Streaming version: handle delays and emit message then done
      // First try to call sendMessage to match its mocking behavior
      this.sendMessageStream = vi.fn(async function* (content: string) {
        // Call sendMessage to trigger any mocked rejections
        const result = await this.sendMessage(content);
        yield { type: 'message', message: result };
        yield { type: 'done' };
      }.bind(this));
      shared.sessions.push({
        state: this.state,
        sendMessage: this.sendMessage,
        interrupt: this.interrupt,
        close: this.close,
      });
    }

    get abortSignal(): AbortSignal {
      return (this.state.config.abortSignal as AbortSignal) ?? new AbortController().signal;
    }

    getInputStreamRef() {
      return {
        pushUserMessage: (content: string) => {
          this.mockInputStreamMessages.push(content);
        },
      };
    }
  }
  return { AgentSession: MockAgentSession };
});

// Import AFTER vi.mock is registered so SubagentManager picks up the mock.
import { SubagentManager } from './subagent.js';
import { runWave } from './subagent/wave.js';

describe('runWave', () => {
  it('resolves with one SubagentResult per task, in task order, when all succeed', async () => {
    const mgr = new SubagentManager();
    shared.sessions.length = 0;
    const h1 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const h2 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const h3 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });

    const results = await runWave([
      { handle: h1, prompt: 'a' },
      { handle: h2, prompt: 'b' },
      { handle: h3, prompt: 'c' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe('succeeded');
    expect(results[1]?.status).toBe('succeeded');
    expect(results[2]?.status).toBe('succeeded');
    expect(results[0]?.message?.content).toBe('ok:a');
    expect(results[1]?.message?.content).toBe('ok:b');
    expect(results[2]?.message?.content).toBe('ok:c');
  });

  it('dispatches one SubagentStop per handle at wave end, with real terminal statuses', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    shared.sessions.length = 0;
    const h1 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const h2 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });

    await runWave([
      { handle: h1, prompt: 'a' },
      { handle: h2, prompt: 'b' },
    ]);

    expect(events).toHaveLength(2);
    const ids = events.map((e) => (e as { subagentId: string }).subagentId).sort();
    expect(ids).toEqual([h1.id, h2.id].sort());
    expect(events.every((e) => (e as { status: string }).status === 'succeeded')).toBe(true);
  });

  it('does NOT short-circuit when one task fails — aggregate preserves partial successes', async () => {
    const mgr = new SubagentManager();
    shared.sessions.length = 0;
    const h1 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const h2 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const h3 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });

    // Middle task fails.
    shared.sessions[1]!.sendMessage.mockRejectedValueOnce(new Error('nope'));

    const results = await runWave(
      [
        { handle: h1, prompt: 'a' },
        { handle: h2, prompt: 'b' },
        { handle: h3, prompt: 'c' },
      ],
      { failFast: false },
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe('succeeded');
    expect(results[1]?.status).toBe('failed');
    expect(results[2]?.status).toBe('succeeded');
  });

  it('fail-fast cancels still-running peers when any task fails', async () => {
    const mgr = new SubagentManager();
    shared.sessions.length = 0;
    const hFast = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    const hSlow = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });

    // Fast task fails immediately; slow task would take 200ms if allowed to run.
    shared.sessions[0]!.sendMessage.mockRejectedValueOnce(new Error('fast-fail'));
    shared.sessions[1]!.state.replyDelayMs = 200;

    const start = Date.now();
    const results = await runWave(
      [
        { handle: hFast, prompt: 'fast' },
        { handle: hSlow, prompt: 'slow' },
      ],
      { failFast: true },
    );
    const elapsed = Date.now() - start;

    expect(results[0]?.status).toBe('failed');
    // Fail-fast cancelled the slow peer; the wave should finish well under 200ms.
    expect(elapsed).toBeLessThan(150);
    // Slow peer's interrupt was invoked because cancel() called session.interrupt.
    expect(shared.sessions[1]!.interrupt).toHaveBeenCalled();
  });

  it('failFast: false lets peers run to natural completion', async () => {
    const mgr = new SubagentManager();
    shared.sessions.length = 0;
    const hFast = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    const hSlow = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });

    shared.sessions[0]!.sendMessage.mockRejectedValueOnce(new Error('fast-fail'));
    shared.sessions[1]!.state.replyDelayMs = 50;

    const results = await runWave(
      [
        { handle: hFast, prompt: 'fast' },
        { handle: hSlow, prompt: 'slow' },
      ],
      { failFast: false },
    );

    expect(results[0]?.status).toBe('failed');
    expect(results[1]?.status).toBe('succeeded');
    // Slow peer should not have been interrupted.
    expect(shared.sessions[1]!.interrupt).not.toHaveBeenCalled();
  });

  it('teardown: false suppresses the end-of-wave stop dispatches', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    shared.sessions.length = 0;
    const h1 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const h2 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });

    await runWave(
      [
        { handle: h1, prompt: 'a' },
        { handle: h2, prompt: 'b' },
      ],
      { teardown: false },
    );

    // No stop events — caller opted out of teardown to keep handles alive.
    expect(events).toHaveLength(0);
  });

  it('handles empty task array without error', async () => {
    const results = await runWave([]);
    expect(results).toEqual([]);
  });

  it('single-task wave works identically to a one-shot forkSubagent', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    shared.sessions.length = 0;
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });

    const results = await runWave([{ handle, prompt: 'solo' }]);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('succeeded');
    expect(events).toHaveLength(1);
  });
});
