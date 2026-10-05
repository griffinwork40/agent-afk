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
