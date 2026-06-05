/**
 * Tests for the `abort` trace event emitted from {@link AbortGraph}.
 *
 * Two surfaces are exercised:
 *   1. Direct AbortGraph use — confirms the BFS descendants array lands in
 *      `cascadedTo`, the `origin` discriminator is honored, and the event
 *      fires before any controller fires (so listeners can observe the
 *      trace in causal order).
 *   2. SubagentManager + SubagentHandleImpl integration — confirms that
 *      `handle.cancel()` and `manager.abortAll()` both produce `abort`
 *      events with the right cascadedTo set, AND that cascade-aborted
 *      sub-agents emit `subagent_lifecycle.cancelled` with source='cascade'
 *      (the recon-paired event).
 *
 * Scope: PR #2 commit 4.
 */

import { describe, it, expect, vi } from 'vitest';
import { AbortGraph } from '../abort-graph.js';
import { InMemoryTraceWriter } from './writer.js';
import type { Message } from '../types.js';

// ---------------------------------------------------------------------------
// AbortGraph direct tests
// ---------------------------------------------------------------------------

describe('AbortGraph — abort trace event', () => {
  it('emits one abort event per abort() call with cascadedTo populated', async () => {
    const writer = new InMemoryTraceWriter();
    const g = new AbortGraph(writer);
    g.register('root', new AbortController());
    g.register('c1', new AbortController());
    g.register('c2', new AbortController());
    g.register('gc1', new AbortController());
    g.linkChild('root', 'c1');
    g.linkChild('root', 'c2');
    g.linkChild('c1', 'gc1');

    g.abort('root', 'shutdown');
    await new Promise((r) => setImmediate(r));

    const aborts = writer.events.filter((e) => e.kind === 'abort');
    expect(aborts).toHaveLength(1);
    const ev = aborts[0];
    if (ev?.kind !== 'abort') throw new Error('unreachable');
    expect(ev.payload.origin).toBe('user_signal');
    expect(ev.payload.reason).toBe('shutdown');
    // BFS order: c1, c2 (children of root, in insertion order), then gc1.
    expect([...ev.payload.cascadedTo].sort()).toEqual(['c1', 'c2', 'gc1']);
  });

  it('honors the origin parameter when callers classify the abort', async () => {
    const writer = new InMemoryTraceWriter();
    const g = new AbortGraph(writer);
    g.register('root', new AbortController());

    g.abort('root', 'over-budget', 'budget');
    await new Promise((r) => setImmediate(r));

    const ev = writer.events.find((e) => e.kind === 'abort');
    if (ev?.kind !== 'abort') throw new Error('expected abort event');
    expect(ev.payload.origin).toBe('budget');
    expect(ev.payload.reason).toBe('over-budget');
    expect(ev.payload.cascadedTo).toEqual([]);
  });

  it('stringifies Error reasons into the trace payload', async () => {
    const writer = new InMemoryTraceWriter();
    const g = new AbortGraph(writer);
    g.register('root', new AbortController());

    g.abort('root', new TypeError('hook said no'), 'hook_block');
    await new Promise((r) => setImmediate(r));

    const ev = writer.events.find((e) => e.kind === 'abort');
    if (ev?.kind !== 'abort') throw new Error('expected abort event');
    expect(ev.payload.origin).toBe('hook_block');
    expect(ev.payload.reason).toBe('hook said no');
  });

  it('does not emit when the node is already aborted', async () => {
    const writer = new InMemoryTraceWriter();
    const g = new AbortGraph(writer);
    const c = new AbortController();
    g.register('root', c);

    g.abort('root', 'first');
    g.abort('root', 'second');
    await new Promise((r) => setImmediate(r));

    const aborts = writer.events.filter((e) => e.kind === 'abort');
    expect(aborts).toHaveLength(1);
    if (aborts[0]?.kind !== 'abort') throw new Error('unreachable');
    expect(aborts[0].payload.reason).toBe('first');
  });

  it('does nothing when the node is not registered', async () => {
    const writer = new InMemoryTraceWriter();
    const g = new AbortGraph(writer);
    g.abort('ghost');
    await new Promise((r) => setImmediate(r));
    expect(writer.events).toHaveLength(0);
  });

  it('no-op when no traceWriter is provided', async () => {
    const g = new AbortGraph();
    g.register('root', new AbortController());
    // Should not throw.
    expect(() => g.abort('root', 'fine')).not.toThrow();
  });

  it('emits before any controller fires (causal ordering)', async () => {
    const writer = new InMemoryTraceWriter();
    const g = new AbortGraph(writer);
    const rootC = new AbortController();
    const childC = new AbortController();
    g.register('root', rootC);
    g.register('child', childC);
    g.linkChild('root', 'child');

    // Snapshot writer.events length at the moment each controller fires.
    // The invariant: the `abort` trace event must already be in the writer
    // before either controller observes its `abort` listeners — otherwise
    // a downstream observer reacting to the controller could read a trace
    // that's missing the originating abort record.
    let lengthAtRoot = -1;
    let lengthAtChild = -1;
    rootC.signal.addEventListener('abort', () => {
      lengthAtRoot = writer.events.length;
    });
    childC.signal.addEventListener('abort', () => {
      lengthAtChild = writer.events.length;
    });

    g.abort('root', 'go');

    // Trace event must be present BEFORE either controller fires.
    expect(lengthAtRoot).toBeGreaterThanOrEqual(1);
    expect(lengthAtChild).toBeGreaterThanOrEqual(1);
    expect(writer.events[0]?.kind).toBe('abort');
  });
});

// ---------------------------------------------------------------------------
// SubagentManager integration — uses the mocked AgentSession from
// subagent-lifecycle.test.ts pattern.
// ---------------------------------------------------------------------------

interface SessionState {
  config: Record<string, unknown>;
  replyContent: string;
  replyDelayMs: number;
}

const shared = vi.hoisted(() => ({
  sessions: [] as Array<{ state: SessionState }>,
}));

vi.mock('../session.js', () => {
  class MockAgentSession {
    public readonly sessionId?: string;
    private readonly state: SessionState;
    public sendMessage: ReturnType<typeof vi.fn>;
    public sendMessageStream: ReturnType<typeof vi.fn>;
    public interrupt = vi.fn(async () => undefined);
    public close = vi.fn(async () => undefined);
    constructor(config: Record<string, unknown>) {
      this.sessionId = (config['sessionId'] as string | undefined) ?? 'child-session-id';
      this.state = { config, replyContent: 'ok', replyDelayMs: 0 };
      this.sendMessage = vi.fn(async (content: string): Promise<Message> => {
        if (this.state.replyDelayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, this.state.replyDelayMs);
            this.abortSignal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                reject(this.abortSignal.reason ?? new Error('aborted'));
              },
              { once: true },
            );
          });
        }
        return { role: 'assistant', content: `${this.state.replyContent}:${content}`, timestamp: new Date() };
      });
      this.sendMessageStream = vi.fn(async function* (content: string) {
        const result = await this.sendMessage(content);
        yield { type: 'message', message: result };
        yield { type: 'done' };
      }.bind(this));
      shared.sessions.push({ state: this.state });
    }
    get abortSignal(): AbortSignal {
      return (this.state.config['abortSignal'] as AbortSignal) ?? new AbortController().signal;
    }
  }
  return { AgentSession: MockAgentSession };
});

import { SubagentManager } from '../subagent.js';

function lastState(): SessionState {
  const last = shared.sessions[shared.sessions.length - 1];
  if (!last) throw new Error('no sessions');
  return last.state;
}

describe('SubagentManager + AbortGraph — abort trace events', () => {
  it('handle.cancel() emits abort with this subagent in cascadedTo (or empty if leaf)', async () => {
    const writer = new InMemoryTraceWriter();
    const mgr = new SubagentManager({ traceWriter: writer });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', traceWriter: writer },
    });

    await handle.cancel();
    await new Promise((r) => setImmediate(r));

    const aborts = writer.events.filter((e) => e.kind === 'abort');
    expect(aborts).toHaveLength(1);
    const ev = aborts[0];
    if (ev?.kind !== 'abort') throw new Error('unreachable');
    expect(ev.payload.origin).toBe('user_signal');
    expect(ev.payload.reason).toBe('cancelled');
    // handle.cancel aborts its own id; the handle has no children so
    // cascadedTo is empty.
    expect(ev.payload.cascadedTo).toEqual([]);
  });

  it('manager.abortAll() emits abort with all subagents in cascadedTo', async () => {
    const writer = new InMemoryTraceWriter();
    const mgr = new SubagentManager({ traceWriter: writer });
    const h1 = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', traceWriter: writer },
    });
    const h2 = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', traceWriter: writer },
    });

    mgr.abortAll('shutdown', 'user_signal');
    await new Promise((r) => setImmediate(r));

    const aborts = writer.events.filter((e) => e.kind === 'abort');
    expect(aborts).toHaveLength(1);
    const ev = aborts[0];
    if (ev?.kind !== 'abort') throw new Error('unreachable');
    expect(ev.payload.origin).toBe('user_signal');
    expect(ev.payload.reason).toBe('shutdown');
    expect([...ev.payload.cascadedTo].sort()).toEqual([h1.id, h2.id].sort());
  });

  it('cascade abort produces subagent_lifecycle.cancelled with source=cascade for each victim', async () => {
    const writer = new InMemoryTraceWriter();
    const mgr = new SubagentManager({ traceWriter: writer });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', traceWriter: writer },
    });
    lastState().replyDelayMs = 200;

    // Kick off a run that will be interrupted by abortAll.
    const runPromise = handle.run('slow').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    mgr.abortAll('parent-shutdown', 'user_signal');
    await runPromise;
    await new Promise((r) => setImmediate(r));

    const lifecycles = writer.events.filter((e) => e.kind === 'subagent_lifecycle');
    const cancelled = lifecycles.find(
      (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'cancelled',
    );
    if (cancelled?.kind !== 'subagent_lifecycle' || cancelled.payload.transition !== 'cancelled') {
      throw new Error('expected cascade-cancelled lifecycle event');
    }
    expect(cancelled.payload.source).toBe('cascade');
    expect(cancelled.payload.subagentId).toBe(handle.id);

    // No failed event should have been emitted for the cascade case.
    const failed = lifecycles.find(
      (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'failed',
    );
    expect(failed).toBeUndefined();
  });

  it('abort event precedes the cascade-cancelled lifecycle in trace order', async () => {
    const writer = new InMemoryTraceWriter();
    const mgr = new SubagentManager({ traceWriter: writer });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', traceWriter: writer },
    });
    lastState().replyDelayMs = 200;

    const runPromise = handle.run('slow').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    mgr.abortAll('parent-shutdown');
    await runPromise;
    await new Promise((r) => setImmediate(r));

    const indexed = writer.events.map((e, i) => ({ i, kind: e.kind }));
    const abortIdx = indexed.find((x) => x.kind === 'abort')?.i;
    const cancelIdx = indexed.find((x) => x.kind === 'subagent_lifecycle' && (() => {
      const ev = writer.events[x.i];
      return ev?.kind === 'subagent_lifecycle' && ev.payload.transition === 'cancelled';
    })())?.i;
    expect(abortIdx).toBeDefined();
    expect(cancelIdx).toBeDefined();
    expect(abortIdx!).toBeLessThan(cancelIdx!);
  });
});
