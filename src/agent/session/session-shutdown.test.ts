import { describe, expect, it } from 'vitest';
import { SessionShutdown } from './session-shutdown.js';
import { AccountingAccumulator } from './accounting-accumulator.js';
import { createHookRegistry } from '../hook-registry.js';
import type { HookContext } from '../hooks.js';
import type { AgentConfig } from '../types.js';

function captureSessionEnd(getAssistantTexts?: () => readonly string[]) {
  const seen: HookContext[] = [];
  const registry = createHookRegistry();
  registry.register('SessionEnd', (ctx) => {
    seen.push(ctx);
    return {};
  });
  const shutdown = new SessionShutdown({
    getConfig: () => ({ model: 'sonnet', cwd: '/repo' }) as unknown as AgentConfig,
    getAbortController: () => new AbortController(),
    getHookRegistry: () => registry,
    accounting: new AccountingAccumulator(),
    getTurnCount: () => 2,
    getSessionId: () => 'sess-1',
    ownedTraceWriter: undefined,
    ownsTraceSeal: false,
    ...(getAssistantTexts ? { getAssistantTexts } : {}),
  });
  return { shutdown, seen };
}

describe('SessionShutdown — assistantTexts threading', () => {
  it('threads in-memory assistant texts onto the SessionEnd context', async () => {
    const { shutdown, seen } = captureSessionEnd(() => ['first', 'second']);
    await shutdown.dispatchOnce('close');
    expect(seen).toHaveLength(1);
    const ctx = seen[0]!;
    expect(ctx.event).toBe('SessionEnd');
    if (ctx.event !== 'SessionEnd') return;
    expect(ctx.assistantTexts).toEqual(['first', 'second']);
    expect(ctx.sessionId).toBe('sess-1');
  });

  it('omits assistantTexts when no getter is supplied', async () => {
    const { shutdown, seen } = captureSessionEnd();
    await shutdown.dispatchOnce('close');
    const ctx = seen[0]!;
    if (ctx.event !== 'SessionEnd') throw new Error('expected SessionEnd');
    expect('assistantTexts' in ctx).toBe(false);
  });
});

describe('SessionShutdown — background SessionEnd lane (/clear latency)', () => {
  function withBackground(parentSessionId?: string) {
    const registry = createHookRegistry();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const finished: string[] = [];
    registry.register('SessionEnd', async (ctx) => {
      await held;
      if (ctx.event === 'SessionEnd') finished.push(ctx.reason ?? '');
      return {};
    }, { background: true });
    const shutdown = new SessionShutdown({
      getConfig: () => ({ model: 'sonnet', cwd: '/repo', ...(parentSessionId ? { parentSessionId } : {}) }) as unknown as AgentConfig,
      getAbortController: () => new AbortController(),
      getHookRegistry: () => registry,
      accounting: new AccountingAccumulator(),
      getTurnCount: () => 1,
      getSessionId: () => 'sess-bg',
      ownedTraceWriter: undefined,
      ownsTraceSeal: false,
    });
    return { shutdown, release, finished };
  }

  it("reason 'reset' returns without waiting for background handlers", async () => {
    const { shutdown, release, finished } = withBackground();
    await shutdown.dispatchOnce('reset');
    expect(finished).toEqual([]);
    release();
  });

  it("reason 'close' waits for background work, including work queued by an earlier reset", async () => {
    const { shutdown, release, finished } = withBackground();
    await shutdown.dispatchOnce('reset');
    shutdown.reset();
    let closed = false;
    const closing = shutdown.dispatchOnce('close').then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(finished).toEqual(['reset', 'close']);
  });

  it('a forked child never drains the shared registry on close', async () => {
    const { shutdown, release, finished } = withBackground('parent-sess');
    await shutdown.dispatchOnce('close');
    expect(finished).toEqual([]);
    release();
  });
});
