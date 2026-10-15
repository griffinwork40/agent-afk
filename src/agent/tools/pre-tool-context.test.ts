import { describe, expect, it, vi } from 'vitest';
import { createHookRegistry } from '../hook-registry.js';
import { executeCommand } from '../hooks/command-executor.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { dispatchPreToolUse } from '../subagent-hooks.js';
import { SessionToolDispatcher } from './dispatcher.js';
import type { ToolCall } from './types.js';

function call(id = 'one'): ToolCall {
  return { id, name: 'echo', input: { message: id }, signal: new AbortController().signal };
}

function fixture(options: Partial<ConstructorParameters<typeof SessionToolDispatcher>[0]> = {}) {
  const registry = createHookRegistry();
  const trace = new InMemoryTraceWriter();
  const handler = vi.fn(async (input: unknown) => ({ content: (input as { message: string }).message }));
  const dispatcher = new SessionToolDispatcher({
    handlers: new Map([['echo', handler]]), schemas: [],
    permissions: { allowedTools: ['echo'] }, hookRegistry: registry, traceWriter: trace,
    ...options,
  });
  return { registry, trace, handler, dispatcher };
}

function deliveries(trace: InMemoryTraceWriter) {
  return trace.events.filter(event => event.kind === 'hook_decision' && event.payload.injectedContextBytes !== undefined);
}

describe('non-blocking PreToolUse context delivery', () => {
  it('delivers real command additionalContext plus updatedInput portably', async () => {
    const { registry, dispatcher, trace, handler } = fixture();
    registry.register('PreToolUse', async context => (await executeCommand({
      command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'check café',updatedInput:{message:'rewritten'}}}))"`,
      context, agentCwd: process.cwd(), sessionId: 'test', timeoutMs: 10000,
    })).decision);
    const result = await dispatcher.execute(call());
    expect(result.content).toBe('rewritten\n\n[PreToolUse context]\ncheck café');
    expect(result.isError).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(deliveries(trace)).toHaveLength(1);
    const event = deliveries(trace)[0]!;
    if (event.kind !== 'hook_decision') throw new Error('unexpected event');
    expect(event.payload.injectedContextBytes).toBe(Buffer.byteLength('check café'));
  });

  it.each([true, false])('keeps concurrent/sequential batch notes isolated (safe=%s)', async safe => {
    const { registry, dispatcher, trace } = fixture({ concurrencyClassifier: () => safe });
    registry.register('PreToolUse', context => ({ injectContext: `note:${context.event === 'PreToolUse' ? context.toolUseId : ''}` }));
    const results = await dispatcher.executeBatch([call('one'), call('two')]);
    expect(results.map(result => result.content)).toEqual([
      'one\n\n[PreToolUse context]\nnote:one', 'two\n\n[PreToolUse context]\nnote:two',
    ]);
    expect(deliveries(trace)).toHaveLength(2);
  });

  it('delivers only once on the single-call batch fast path', async () => {
    const { registry, dispatcher, trace } = fixture();
    registry.register('PreToolUse', () => ({ decision: 'approve', injectContext: 'note' }));
    const [result] = await dispatcher.executeBatch([call()]);
    expect(result!.content).toBe('one\n\n[PreToolUse context]\nnote');
    expect(deliveries(trace)).toHaveLength(1);
  });

  it('merges notes and preserves context after the output cap', async () => {
    const { registry, dispatcher } = fixture({ maxOutputBytes: 10 });
    registry.register('PreToolUse', () => ({ injectContext: 'first' }));
    registry.register('PreToolUse', () => ({ injectContext: 'second' }));
    const result = await dispatcher.execute({ ...call(), input: { message: 'x'.repeat(1000) } });
    expect(result.truncated).toBe(true);
    expect(result.content).toMatch(/\[PreToolUse context\]\nfirst\nsecond$/);
  });

  it('preserves context on a later permission denial without executing', async () => {
    const { registry, dispatcher, handler } = fixture({ permissions: { allowedTools: [] } });
    registry.register('PreToolUse', () => ({ injectContext: 'note' }));
    const result = await dispatcher.execute(call());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[PreToolUse context]\nnote');
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves context on a handler failure', async () => {
    const { registry, dispatcher } = fixture({ handlers: new Map([['echo', async () => { throw new Error('oops'); }]]) });
    registry.register('PreToolUse', () => ({ injectContext: 'note' }));
    const result = await dispatcher.execute(call());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('oops');
    expect(result.content).toContain('[PreToolUse context]\nnote');
  });

  it('leaves blocking context on the existing block path without duplication', async () => {
    const { registry, dispatcher, handler } = fixture();
    registry.register('PreToolUse', () => ({ decision: 'block', injectContext: 'use a safer tool' }));
    const result = await dispatcher.execute(call());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('use a safer tool');
    expect(result.content).not.toContain('[PreToolUse context]');
    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers context when the batch aborts after gate admission', async () => {
    const controller = new AbortController();
    const { registry, dispatcher, handler, trace } = fixture();
    registry.register('PreToolUse', () => ({ injectContext: 'note' }));
    registry.register('PostToolUse', () => { controller.abort(); return {}; });
    const results = await dispatcher.executeBatch([call('one'), { ...call('two'), signal: controller.signal }]);
    expect(results[1]!.isError).toBe(true);
    expect(results[1]!.content).toContain('[PreToolUse context]');
    expect(deliveries(trace)).toHaveLength(2);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not count dispatch-only context as delivered', async () => {
    const { registry, trace } = fixture();
    registry.register('PreToolUse', () => ({ injectContext: 'note' }));
    const decision = await dispatchPreToolUse(registry, { event: 'PreToolUse', toolName: 'echo', input: {} }, { traceWriter: trace });
    expect(decision.injectContext).toBe('note');
    expect(deliveries(trace)).toHaveLength(0);
  });

  it.each([undefined, ''])('no stray banner for empty/missing context (%s)', async injectContext => {
    const { registry, dispatcher, trace } = fixture();
    registry.register('PreToolUse', () => injectContext === undefined ? {} : { injectContext });
    expect((await dispatcher.execute(call())).content).toBe('one');
    expect(deliveries(trace)).toHaveLength(0);
  });
});

describe('PreToolContext unit', () => {
  it('capture("") does not store and deliver returns the original result unchanged', async () => {
    const { PreToolContext } = await import('./pre-tool-context.js');
    const ctx = new PreToolContext();
    const c = call();
    const result = { content: 'base', isError: false as const };
    ctx.capture(c, ''); // empty string: guard inside capture must skip set()
    const out = await ctx.deliver(c, result);
    // No context stored → no banner appended; original result returned as-is
    expect(out).toBe(result);
    expect(out.content).toBe('base');
  });

  it('capture(non-empty) then deliver returns a NEW object with the banner', async () => {
    const { PreToolContext } = await import('./pre-tool-context.js');
    const ctx = new PreToolContext();
    const c = call();
    const result = { content: 'output', isError: false as const };
    ctx.capture(c, 'injected note');
    const out = await ctx.deliver(c, result);
    // Must be a new object — not the same reference
    expect(out).not.toBe(result);
    expect(out.content).toBe('output\n\n[PreToolUse context]\ninjected note');
    // Original must be untouched
    expect(result.content).toBe('output');
  });
});
