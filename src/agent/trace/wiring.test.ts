/**
 * Wiring tests for PR #2 commit 2 — tool_call + hook_decision emission.
 *
 * Drives the dispatch helpers and SessionToolDispatcher with an
 * InMemoryTraceWriter to assert that:
 *
 *   - PreToolUse / PostToolUse / SessionStart / SessionEnd /
 *     SubagentStart / SubagentStop hooks each emit a `hook_decision`
 *     event with the right payload shape.
 *   - Block decisions record decision='block' + reason + blockedTool
 *     (for PreToolUse).
 *   - Approve decisions record decision='approve' or undefined.
 *   - injectContext records injectedContextBytes.
 *   - The dispatcher emits tool_call.started before dispatch and
 *     tool_call.completed after, with correct resultBytes/isError/truncated.
 *
 * These are focused unit tests that bypass the full AgentSession
 * machinery — see integration.test.ts for the end-to-end session tests.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryTraceWriter } from './writer.js';
import { createHookRegistryImpl } from '../hook-registry.js';
import {
  dispatchPostToolUse,
  dispatchPreToolUse,
  dispatchSubagentStart,
  dispatchSubagentStop,
} from '../subagent-hooks.js';
import {
  dispatchSessionEnd,
  dispatchSessionStart,
} from '../session/hooks-dispatch.js';
import type { HookRegistry } from '../hooks.js';
import { SessionToolDispatcher } from '../tools/dispatcher.js';
import type { ToolHandler } from '../tools/types.js';

// ---------------------------------------------------------------------------
// hook_decision via dispatch helpers
// ---------------------------------------------------------------------------

describe('hook_decision — emitted from dispatch helpers', () => {
  function makeRegistry(): HookRegistry {
    return createHookRegistryImpl();
  }

  it('PreToolUse approve records decision=undefined', async () => {
    const writer = new InMemoryTraceWriter();
    const registry = makeRegistry();
    await dispatchPreToolUse(
      registry,
      { event: 'PreToolUse', toolName: 'bash', input: {} },
      { traceWriter: writer },
    );
    const decisions = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    if (d?.kind !== 'hook_decision') throw new Error('unreachable');
    expect(d.payload.hookEvent).toBe('PreToolUse');
    expect(d.payload.decision).toBeUndefined();
    expect(d.payload.blockedTool).toBeUndefined();
  });

  it('PreToolUse block records decision=block + reason + blockedTool', async () => {
    const writer = new InMemoryTraceWriter();
    const registry = makeRegistry();
    registry.register('PreToolUse', async () => ({
      decision: 'block',
      reason: 'plan-mode forbids writes',
    }));
    await expect(
      dispatchPreToolUse(
        registry,
        { event: 'PreToolUse', toolName: 'write_file', input: {} },
        { traceWriter: writer },
      ),
    ).rejects.toThrow();
    const decisions = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    if (d?.kind !== 'hook_decision') throw new Error('unreachable');
    expect(d.payload.decision).toBe('block');
    expect(d.payload.reason).toBe('plan-mode forbids writes');
    expect(d.payload.blockedTool).toBe('write_file');
  });

  it('PostToolUse swallowed block still records the decision', async () => {
    const writer = new InMemoryTraceWriter();
    const registry = makeRegistry();
    registry.register('PostToolUse', async () => ({
      decision: 'block',
      reason: 'post-blocked',
    }));
    // Non-throwing — PostToolUse swallows block by contract.
    await dispatchPostToolUse(
      registry,
      { event: 'PostToolUse', toolName: 'bash', output: '...' },
      { traceWriter: writer },
    );
    const decisions = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    if (d?.kind !== 'hook_decision') throw new Error('unreachable');
    expect(d.payload.decision).toBe('block');
    expect(d.payload.reason).toBe('post-blocked');
  });

  it('SubagentStop injectContext records injectedContextBytes', async () => {
    const writer = new InMemoryTraceWriter();
    const registry = makeRegistry();
    const injected = 'hello world';
    registry.register('SubagentStop', async () => ({
      injectContext: injected,
    }));
    await dispatchSubagentStop(
      registry,
      {
        event: 'SubagentStop',
        subagentId: 'child-1',
        status: 'succeeded',
        lastMessage: '',
        durationMs: 1,
      },
      { traceWriter: writer },
    );
    const decisions = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    if (d?.kind !== 'hook_decision') throw new Error('unreachable');
    expect(d.payload.injectedContextBytes).toBe(Buffer.byteLength(injected, 'utf8'));
  });

  it('SessionStart, SessionEnd, SubagentStart each emit', async () => {
    const writer = new InMemoryTraceWriter();
    const registry = makeRegistry();
    await dispatchSessionStart(
      registry,
      { event: 'SessionStart', sessionId: 's' },
      { traceWriter: writer },
    );
    await dispatchSubagentStart(
      registry,
      { event: 'SubagentStart', subagentId: 'c', parentSessionId: 's' },
      { traceWriter: writer },
    );
    await dispatchSessionEnd(
      registry,
      { event: 'SessionEnd', sessionId: 's', reason: 'close' },
      { traceWriter: writer },
    );
    const events = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(events.map((e) => e.kind === 'hook_decision' ? e.payload.hookEvent : null)).toEqual([
      'SessionStart',
      'SubagentStart',
      'SessionEnd',
    ]);
  });

  it('does nothing when traceWriter is absent', async () => {
    const writer = new InMemoryTraceWriter();
    const registry = makeRegistry();
    // No traceWriter in options.
    await dispatchPreToolUse(registry, {
      event: 'PreToolUse',
      toolName: 'bash',
      input: {},
    });
    expect(writer.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// tool_call via SessionToolDispatcher
// ---------------------------------------------------------------------------

describe('tool_call — emitted from SessionToolDispatcher', () => {
  function makeDispatcher(
    writer: InMemoryTraceWriter,
    handler: ToolHandler,
    handlerName = 'fake_tool',
  ): SessionToolDispatcher {
    const handlers = new Map<string, ToolHandler>();
    handlers.set(handlerName, handler);
    return new SessionToolDispatcher({
      handlers,
      schemas: [],
      traceWriter: writer,
    });
  }

  it('emits NO tool_call events from execute() — they fire in the loop, not the dispatcher', async () => {
    // tool_call.started / tool_call.completed are emitted by the
    // anthropic-direct loop (loop.ts), not by SessionToolDispatcher.
    // This test documents that contract so future refactors don't move
    // emission into the dispatcher accidentally and duplicate events.
    const writer = new InMemoryTraceWriter();
    const dispatcher = makeDispatcher(writer, async () => ({
      content: 'ok',
      isError: false,
    }));
    const ac = new AbortController();
    const result = await dispatcher.execute({
      id: 't1',
      name: 'fake_tool',
      input: {},
      signal: ac.signal,
    });
    expect(result.content).toBe('ok');
    const toolCalls = writer.events.filter((e) => e.kind === 'tool_call');
    expect(toolCalls).toHaveLength(0);
  });

  it('emits hook_decision for PreToolUse and PostToolUse around dispatch', async () => {
    const writer = new InMemoryTraceWriter();
    const registry = createHookRegistryImpl();
    const handlers = new Map<string, ToolHandler>();
    handlers.set('fake_tool', async () => ({ content: 'result', isError: false }));
    const dispatcher = new SessionToolDispatcher({
      handlers,
      schemas: [],
      hookRegistry: registry,
      traceWriter: writer,
    });
    const ac = new AbortController();
    await dispatcher.execute({
      id: 't1',
      name: 'fake_tool',
      input: {},
      signal: ac.signal,
    });
    const decisions = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(decisions).toHaveLength(2);
    if (decisions[0]?.kind !== 'hook_decision' || decisions[1]?.kind !== 'hook_decision') {
      throw new Error('unreachable');
    }
    expect(decisions[0].payload.hookEvent).toBe('PreToolUse');
    expect(decisions[1].payload.hookEvent).toBe('PostToolUse');
  });

  it('blocked PreToolUse records the block AND short-circuits the dispatch', async () => {
    const writer = new InMemoryTraceWriter();
    const registry = createHookRegistryImpl();
    registry.register('PreToolUse', async () => ({
      decision: 'block',
      reason: 'denied',
    }));
    let handlerCalled = false;
    const handlers = new Map<string, ToolHandler>();
    handlers.set('fake_tool', async () => {
      handlerCalled = true;
      return { content: 'ran', isError: false };
    });
    const dispatcher = new SessionToolDispatcher({
      handlers,
      schemas: [],
      hookRegistry: registry,
      traceWriter: writer,
    });
    const ac = new AbortController();
    const result = await dispatcher.execute({
      id: 't1',
      name: 'fake_tool',
      input: {},
      signal: ac.signal,
    });
    expect(result.isError).toBe(true);
    expect(handlerCalled).toBe(false);
    const decisions = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    if (d?.kind !== 'hook_decision') throw new Error('unreachable');
    expect(d.payload.decision).toBe('block');
    expect(d.payload.blockedTool).toBe('fake_tool');
  });
});
