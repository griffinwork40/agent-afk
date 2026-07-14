/**
 * Tests for `subagent_lifecycle` trace events emitted from
 * `SubagentManager.forkSubagent` and `SubagentHandleImpl.run`/`cancel`.
 *
 * Uses the same `vi.mock('./session.js')` fixture as `subagent.test.ts`
 * — a minimal `MockAgentSession` lets us drive `forkSubagent → run`
 * without standing up a real provider.
 *
 * Scope: PR #2 commit 3 — exercises the four transitions:
 *   - started     (emitted from forkSubagent after handle wired)
 *   - succeeded   (emitted from run() success branch)
 *   - failed      (emitted from run() catch when not already cancelled)
 *   - cancelled   (emitted from cancel() with source='explicit')
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '../types.js';
import { InMemoryTraceWriter } from './writer.js';

interface SessionState {
  config: Record<string, unknown>;
  replyContent: string | ((prompt: string) => string);
  replyDelayMs: number;
  throwOnSend?: Error;
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
      this.state = { config, replyContent: '', replyDelayMs: 0 };
      this.sendMessage = vi.fn(async (content: string): Promise<Message> => {
        if (this.state.throwOnSend) throw this.state.throwOnSend;
        const reply =
          typeof this.state.replyContent === 'function'
            ? this.state.replyContent(content)
            : this.state.replyContent || `ok:${content}`;
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
        return { role: 'assistant', content: reply, timestamp: new Date() };
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

describe('subagent_lifecycle trace events', () => {
  describe('started', () => {
    it('emits when forkSubagent registers a new handle', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'parent-1' },
        config: { model: 'sonnet', traceWriter: writer },
        idPrefix: 'child',
      });

      // started fires synchronously inside forkSubagent (fire-and-forget),
      // but the emit helper awaits writer.write internally. Drain microtasks.
      await new Promise((resolve) => setImmediate(resolve));

      const lifecycles = writer.events.filter((e) => e.kind === 'subagent_lifecycle');
      expect(lifecycles).toHaveLength(1);
      const ev = lifecycles[0];
      if (ev?.kind !== 'subagent_lifecycle') throw new Error('unreachable');
      if (ev.payload.transition !== 'started') throw new Error('expected started');
      expect(ev.payload.subagentId).toBe(handle.id);
      expect(ev.payload.parentId).toBe('parent-1');
      expect(ev.payload.model).toBe('sonnet');
      expect(ev.payload.allowedTools).toBeUndefined();
    });

    it('records allowedTools when child config carries them', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'parent-2' },
        config: {
          model: 'sonnet',
          traceWriter: writer,
          tools: { allowedTools: ['bash', 'read_file'] },
        },
      });
      await new Promise((resolve) => setImmediate(resolve));

      const started = writer.events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'started',
      );
      if (started?.kind !== 'subagent_lifecycle' || started.payload.transition !== 'started') {
        throw new Error('expected started event');
      }
      expect(started.payload.allowedTools).toEqual(['bash', 'read_file']);
    });

    // Observability: promptHead + agentType (PR: observable forked children).
    it('records agentType and a re-clamped promptHead when supplied', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      // 100-char prompt head; the emit re-clamps to 80 to honour the payload
      // contract regardless of caller input.
      const longHead = 'x'.repeat(100);
      await mgr.forkSubagent({
        parent: { sessionId: 'parent-3' },
        config: { model: 'sonnet', traceWriter: writer },
        agentType: 'research-agent',
        promptHead: longHead,
      });
      await new Promise((resolve) => setImmediate(resolve));

      const started = writer.events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'started',
      );
      if (started?.kind !== 'subagent_lifecycle' || started.payload.transition !== 'started') {
        throw new Error('expected started event');
      }
      expect(started.payload.agentType).toBe('research-agent');
      expect(started.payload.promptHead).toBe('x'.repeat(80));
      expect(started.payload.promptHead?.length).toBe(80);
    });

    it('omits promptHead when blank/whitespace and agentType when unset', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'parent-4' },
        config: { model: 'sonnet', traceWriter: writer },
        promptHead: '   ', // whitespace-only → treated as absent
        // no agentType
      });
      await new Promise((resolve) => setImmediate(resolve));

      const started = writer.events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'started',
      );
      if (started?.kind !== 'subagent_lifecycle' || started.payload.transition !== 'started') {
        throw new Error('expected started event');
      }
      expect(started.payload.promptHead).toBeUndefined();
      expect(started.payload.agentType).toBeUndefined();
    });

    it('falls back to manager rootId when parent has no sessionId', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: undefined },
        config: { model: 'sonnet', traceWriter: writer },
      });
      await new Promise((resolve) => setImmediate(resolve));

      const started = writer.events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'started',
      );
      if (started?.kind !== 'subagent_lifecycle' || started.payload.transition !== 'started') {
        throw new Error('expected started event');
      }
      // parentId is the manager's internal rootId — opaque but always a string.
      expect(typeof started.payload.parentId).toBe('string');
      expect(started.payload.parentId.length).toBeGreaterThan(0);
    });

    it('does nothing when traceWriter is absent', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      // No traceWriter on the child config.
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(writer.events).toHaveLength(0);
    });

    // Regression: the `agent`-tool path never sets config.traceWriter — its
    // forks relied on manager-level inheritance, which only reached the
    // child session's own events, NOT the lifecycle emits or the handle.
    // Result: raw agent dispatches were invisible in `afk trace show`
    // (the 2026-07-06 stuck-subagent incident's forensic dead end).
    // forkSubagent now resolves effectiveTraceWriter = config → manager.
    it('inherits the manager-level writer when config.traceWriter is unset', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager({ traceWriter: writer });
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'parent-mgr' },
        config: { model: 'sonnet' }, // no per-fork traceWriter — the agent-tool shape
        idPrefix: 'agent-tool',
      });
      await new Promise((resolve) => setImmediate(resolve));

      const started = writer.events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'started',
      );
      if (started?.kind !== 'subagent_lifecycle' || started.payload.transition !== 'started') {
        throw new Error('expected started event via manager-level writer');
      }
      expect(started.payload.subagentId).toBe(handle.id);
      expect(started.payload.parentId).toBe('parent-mgr');
    });

    it('manager-level writer also covers the handle terminal emits (succeeded)', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager({ traceWriter: writer });
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' }, // no per-fork traceWriter
      });
      await handle.run('hi');
      await new Promise((resolve) => setImmediate(resolve));

      const transitions = writer.events
        .filter((e) => e.kind === 'subagent_lifecycle')
        .map((e) => (e.kind === 'subagent_lifecycle' ? e.payload.transition : ''));
      expect(transitions).toContain('started');
      expect(transitions).toContain('succeeded');
    });

    it('per-fork config.traceWriter wins over the manager-level writer', async () => {
      const managerWriter = new InMemoryTraceWriter();
      const forkWriter = new InMemoryTraceWriter();
      const mgr = new SubagentManager({ traceWriter: managerWriter });
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', traceWriter: forkWriter },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        forkWriter.events.some(
          (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'started',
        ),
      ).toBe(true);
      expect(managerWriter.events).toHaveLength(0);
    });
  });

  describe('succeeded', () => {
    it('emits after run() resolves with the assistant message', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', traceWriter: writer },
      });
      lastState().replyContent = 'hello world';

      await handle.run('go');
      await new Promise((resolve) => setImmediate(resolve));

      const succeeded = writer.events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'succeeded',
      );
      if (succeeded?.kind !== 'subagent_lifecycle' || succeeded.payload.transition !== 'succeeded') {
        throw new Error('expected succeeded event');
      }
      expect(succeeded.payload.subagentId).toBe(handle.id);
      expect(succeeded.payload.outputBytes).toBe(Buffer.byteLength('hello world', 'utf8'));
      expect(succeeded.payload.durationMs).toBeGreaterThanOrEqual(0);
      // turnCount is taken from the trace; the mock yields one assistant
      // message so turnCount=1.
      expect(succeeded.payload.turnCount).toBe(1);
    });

    it('started precedes succeeded in trace order', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', traceWriter: writer },
      });
      await handle.run('go');
      await new Promise((resolve) => setImmediate(resolve));

      const transitions = writer.events
        .filter((e) => e.kind === 'subagent_lifecycle')
        .map((e) => (e.kind === 'subagent_lifecycle' ? e.payload.transition : ''));
      expect(transitions).toEqual(['started', 'succeeded']);
    });
  });

  describe('failed', () => {
    it('emits when the underlying session throws', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', traceWriter: writer },
      });
      lastState().throwOnSend = new TypeError('boom');

      await expect(handle.run('go')).rejects.toThrow(/boom/);
      await new Promise((resolve) => setImmediate(resolve));

      const failed = writer.events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'failed',
      );
      if (failed?.kind !== 'subagent_lifecycle' || failed.payload.transition !== 'failed') {
        throw new Error('expected failed event');
      }
      expect(failed.payload.subagentId).toBe(handle.id);
      expect(failed.payload.errorClass).toBe('TypeError');
      expect(failed.payload.errorMessage).toBe('boom');
      expect(failed.payload.partialOutputBytes).toBe(0);
    });
  });

  describe('cancelled', () => {
    it('emits with source=explicit when cancel() is called', async () => {
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', traceWriter: writer },
      });

      await handle.cancel();
      await new Promise((resolve) => setImmediate(resolve));

      const cancelled = writer.events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'cancelled',
      );
      if (cancelled?.kind !== 'subagent_lifecycle' || cancelled.payload.transition !== 'cancelled') {
        throw new Error('expected cancelled event');
      }
      expect(cancelled.payload.subagentId).toBe(handle.id);
      expect(cancelled.payload.source).toBe('explicit');
    });

    it('does not double-emit cancelled+failed when cancel races run()', async () => {
      // Set up a slow run so cancel() can fire mid-flight. cancel() sets
      // status='cancelled' BEFORE aborting; the run's catch block then
      // sees status='cancelled' and suppresses its own failed emission.
      const writer = new InMemoryTraceWriter();
      const mgr = new SubagentManager();
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', traceWriter: writer },
      });
      lastState().replyDelayMs = 200;

      const runPromise = handle.run('slow').catch(() => undefined);
      // Wait a tick for the run to actually start.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await handle.cancel();
      await runPromise;
      await new Promise((resolve) => setImmediate(resolve));

      const lifecycles = writer.events.filter((e) => e.kind === 'subagent_lifecycle');
      const transitions = lifecycles.map((e) =>
        e.kind === 'subagent_lifecycle' ? e.payload.transition : '',
      );
      // started, then cancelled — no failed should appear.
      expect(transitions).toContain('started');
      expect(transitions).toContain('cancelled');
      expect(transitions).not.toContain('failed');
    });
  });
});
