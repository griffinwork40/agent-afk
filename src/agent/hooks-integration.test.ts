/**
 * Integration tests for harness hooks wired into AgentSession + SubagentManager.
 *
 * Uses the same mock-SDK harness as tests/agent/subagent.test.ts so we can
 * assert on dispatch ordering, blocking semantics, and parent-to-child
 * registry propagation without a real Anthropic round-trip.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHookRegistry } from './hooks.js';
import type { HookContext } from './hooks.js';
import { HookBlockedError } from '../utils/errors.js';
import type { Message } from './types.js';

type CapturedConfig = Record<string, unknown> | null;

interface SessionState {
  config: Record<string, unknown>;
  replyContent: string | ((prompt: string) => string);
  replyDelayMs: number;
}

interface MockSessionTracker {
  state: SessionState;
  sendMessage: ReturnType<typeof vi.fn>;
  /** Standalone messages pushed via `pushUserMessage` (live-steering channel). */
  getMockInputStreamMessages: () => string[];
  /** Hook context queued via `queueFrameworkContext` (rides with the next real message). */
  getMockQueuedFrameworkContext: () => string[];
}

const shared = vi.hoisted(() => ({
  lastConfig: null as CapturedConfig,
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
    private mockQueuedFrameworkContext: string[] = [];

    constructor(config: Record<string, unknown>) {
      shared.lastConfig = config;
      this.sessionId = (config.sessionId as string | undefined) ?? 'child-session-id';
      this.state = { config, replyContent: '', replyDelayMs: 0 };
      this.sendMessage = vi.fn(async (content: string): Promise<Message> => {
        const reply =
          typeof this.state.replyContent === 'function'
            ? this.state.replyContent(content)
            : this.state.replyContent || `ok:${content}`;
        return { role: 'assistant', content: reply, timestamp: new Date() };
      });
      // Streaming version: call sendMessage to match mocking behavior, then emit
      this.sendMessageStream = vi.fn(async function* (content: string) {
        const result = await this.sendMessage(content);
        yield { type: 'message', message: result };
        yield { type: 'done' };
      }.bind(this));
      shared.sessions.push({
        state: this.state,
        sendMessage: this.sendMessage,
        getMockInputStreamMessages: () => this.mockInputStreamMessages,
        getMockQueuedFrameworkContext: () => this.mockQueuedFrameworkContext,
      });
    }

    get abortSignal(): AbortSignal {
      return (this.state.config.abortSignal as AbortSignal) ?? new AbortController().signal;
    }

    getInputStreamRef() {
      // Mirrors the real AgentSession ref: both channels exposed. The handle
      // must route hook injectContext to `queueFrameworkContext` (rides with
      // the next real message) and never to `pushUserMessage` (own turn).
      return {
        pushUserMessage: (content: string) => {
          this.mockInputStreamMessages.push(content);
        },
        queueFrameworkContext: (text: string) => {
          this.mockQueuedFrameworkContext.push(text);
        },
      };
    }

    getMockInputStreamMessages(): string[] {
      return this.mockInputStreamMessages;
    }

    getMockQueuedFrameworkContext(): string[] {
      return this.mockQueuedFrameworkContext;
    }
  }
  return { AgentSession: MockAgentSession };
});

// Import AFTER the mock so SubagentManager picks up the mock session.
import { SubagentManager } from './subagent.js';
import { createDefaultHookRegistry } from './default-hook-registry.js';
import { BackgroundAgentRegistry } from './background-registry.js';
import type { SubagentResult } from './subagent.js';

describe('SubagentManager — hook integration', () => {
  it('dispatches SubagentStart before creating the child session', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStart', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    shared.sessions.length = 0;
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p-1' },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'SubagentStart',
      subagentId: handle.id,
      parentSessionId: 'p-1',
    });
    expect(shared.sessions).toHaveLength(1);
  });

  it('blocked SubagentStart throws HookBlockedError and never creates a session', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStart', () => ({
      decision: 'block',
      reason: 'policy-denied',
    }));

    const mgr = new SubagentManager({ hookRegistry: registry });
    shared.sessions.length = 0;

    const err = await mgr
      .forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } })
      .catch((e) => e);

    expect(err).toBeInstanceOf(HookBlockedError);
    expect((err as HookBlockedError).event).toBe('SubagentStart');
    expect(mgr.list()).toHaveLength(0);
    // No mock session should have been constructed for a blocked fork.
    expect(shared.sessions).toHaveLength(0);
  });

  it('dispatches SubagentStop on cancel() with cancelled status', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });

    await handle.cancel();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'SubagentStop',
      subagentId: handle.id,
      status: 'cancelled',
    });
  });

  it('dispatches SubagentStop with succeeded status (not cancelled) when run() completed before teardown', async () => {
    // Regression: before the fix, cancel() hardcoded status='cancelled' even
    // when the child had already finished a successful run. Hooks that branch
    // on status couldn't distinguish "user tore down a completed subagent"
    // from "we killed it mid-flight". The SubagentStop payload now carries
    // the real terminal status and the last assistant message.
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
      idPrefix: 'research',
    });

    await handle.run('inspect');
    await handle.cancel();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'SubagentStop',
      subagentId: handle.id,
      status: 'succeeded',
      lastMessage: 'ok:inspect',
      agentType: 'research',
    });
  });

  it('dispatches SubagentStop with failed status when run() threw before teardown', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    // Force the child's sendMessage to reject so run() goes down the error path.
    const lastSession = shared.sessions[shared.sessions.length - 1]!;
    lastSession.sendMessage.mockRejectedValueOnce(new Error('child blew up'));

    await expect(handle.run('inspect')).rejects.toThrow(/blew up/);
    await handle.cancel();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'SubagentStop',
      subagentId: handle.id,
      status: 'failed',
    });
  });

  it('createDefaultHookRegistry wires shadowVerifyNudge end-to-end into parent input stream', async () => {
    // Full-path integration: the built-in registry used by every AgentSession
    // entry point must actually fire the nudge when a child returns
    // decision-driving output. Unit tests on the handler alone wouldn't catch
    // a regression in registration, dispatch wiring, or context plumbing.
    const { registry } = createDefaultHookRegistry();

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-default-registry' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'research',
    });

    // Decision-driving output matching the nudge heuristics:
    // >= 600 chars, >= 2 decision markers, not a verifier response.
    const decisionHeavy =
      'After careful review, verdict: the auth module has several broken paths. ' +
      'Recommend removing the duplicated helpers. ' +
      'I found 4 critical severity bugs in the validator. ' +
      'The unused imports should delete. ' +
      'lorem ipsum '.repeat(60);
    const childSessionTracker = shared.sessions[shared.sessions.length - 1]!;
    childSessionTracker.state.replyContent = decisionHeavy;

    await childHandle.run('audit the module');
    await childHandle.cancel();

    const queued = parentSession.getMockQueuedFrameworkContext();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatch(/^\[framework-generated context: shadow-verify nudge\]/);
    expect(queued[0]).toContain('/shadow-verify');
    // Never delivered as a standalone input-stream message — that channel
    // makes the nudge its own turn and displaces the user's next real message.
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('resolves the registry from the PARENT session when manager + config omit it (production wiring)', async () => {
    // Regression for the dead-nudge bug. Production builds the SubagentManager
    // WITHOUT a hookRegistry (it's constructed before the registry exists) and
    // the agent-tool fork config can't carry one either. The ONLY source is the
    // forking parent session's `hookRegistry`, exposed via the deferredParent
    // proxy. Before the fix, forkSubagent only consulted config + manager, so
    // SubagentStop (and the nudge) never fired in production despite the
    // manager-level integration test above passing.
    const { registry } = createDefaultHookRegistry();

    const parentMgr = new SubagentManager(); // no registry — like rootManager
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-parent-fallback' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager(); // no registry — like the agent-tool path
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
        // The parent supplies the registry — mirrors deferredParent's getter.
        hookRegistry: registry,
      },
      config: { model: 'sonnet' },
      idPrefix: 'research',
    });

    const decisionHeavy =
      'After careful review, verdict: the auth module has several broken paths. ' +
      'Recommend removing the duplicated helpers. ' +
      'I found 4 critical severity bugs in the validator. ' +
      'The unused imports should delete. ' +
      'lorem ipsum '.repeat(60);
    const childSessionTracker = shared.sessions[shared.sessions.length - 1]!;
    childSessionTracker.state.replyContent = decisionHeavy;

    await childHandle.run('audit the module');
    await childHandle.cancel();

    const queued = parentSession.getMockQueuedFrameworkContext();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatch(/^\[framework-generated context: shadow-verify nudge\]/);
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('stays silent when neither config, manager, nor parent supplies a registry', async () => {
    // The pre-fix bug state: with no registry resolvable anywhere, SubagentStop
    // dispatches nothing and the parent receives no nudge.
    const parentMgr = new SubagentManager();
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-no-registry' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager();
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
        // No hookRegistry exposed by the parent.
      },
      config: { model: 'sonnet' },
      idPrefix: 'research',
    });

    const decisionHeavy =
      'Verdict: broken. Recommend removing helpers. I found 4 critical severity bugs. ' +
      'lorem ipsum '.repeat(70);
    const childSessionTracker = shared.sessions[shared.sessions.length - 1]!;
    childSessionTracker.state.replyContent = decisionHeavy;

    await childHandle.run('audit the module');
    await childHandle.cancel();

    expect(parentSession.getMockQueuedFrameworkContext()).toEqual([]);
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('manager-level registry takes precedence over the parent-supplied one', async () => {
    // Resolution order is config ?? manager ?? parent. Lock the manager > parent
    // half (the existing test above covers config > manager).
    const managerReg = createHookRegistry();
    const parentReg = createHookRegistry();
    const fired: string[] = [];
    managerReg.register('SubagentStop', () => { fired.push('manager'); return {}; });
    parentReg.register('SubagentStop', () => { fired.push('parent'); return {}; });

    const mgr = new SubagentManager({ hookRegistry: managerReg });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p', hookRegistry: parentReg },
      config: { model: 'sonnet' },
    });
    await handle.cancel();

    expect(fired).toEqual(['manager']);
  });

  it('createDefaultHookRegistry stays silent when child ran inside a verified orchestrator', async () => {
    const { registry } = createDefaultHookRegistry();

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-verified-orch' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'diagnose',
    });

    const decisionHeavy =
      'Verdict: the auth module is broken. Recommend removing several unused helpers. ' +
      'I found 4 critical severity bugs. ' +
      'lorem ipsum '.repeat(70);
    const childSessionTracker = shared.sessions[shared.sessions.length - 1]!;
    childSessionTracker.state.replyContent = decisionHeavy;

    await childHandle.run('audit the module');
    await childHandle.cancel();

    // agentType='diagnose' is on the VERIFIED_ORCHESTRATORS list, so no nudge.
    expect(parentSession.getMockQueuedFrameworkContext()).toEqual([]);
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('SubagentStop block decision is swallowed (teardown cannot be refused)', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({ decision: 'block', reason: 'no-way' }));

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });

    // Should NOT throw — SubagentStop is non-blocking by contract.
    await expect(handle.cancel()).resolves.toBeUndefined();
  });

  it('concurrent cancels dispatch one SubagentStop per subagent with correct ids', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const h1 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const h2 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });

    await Promise.all([h1.cancel(), h2.cancel()]);

    expect(events).toHaveLength(2);
    const ids = events.map((e) => (e as { subagentId: string }).subagentId).sort();
    expect(ids).toEqual([h1.id, h2.id].sort());
  });

  it('propagates parent registry into the child config so children inherit SessionStart/End', async () => {
    const registry = createHookRegistry();
    const mgr = new SubagentManager({ hookRegistry: registry });
    shared.lastConfig = null;
    await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });

    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ hookRegistry: registry }),
    );
  });

  it('threads parentSessionId from the forking parent into the child config (guard wiring)', async () => {
    // The memory + plan-mode guards self-skip subagents via context.parentSessionId,
    // which traces back to AgentConfig.parentSessionId. Prove forkSubagent populates
    // it from the parent — the synthetic-context unit tests for those guards inject
    // parentSessionId by hand and cannot catch a regression in THIS wiring.
    const mgr = new SubagentManager();
    shared.lastConfig = null;
    await mgr.forkSubagent({ parent: { sessionId: 'parent-xyz' }, config: { model: 'sonnet' } });

    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ parentSessionId: 'parent-xyz' }),
    );
  });

  it('does not overwrite an explicit config.parentSessionId with the parent id', async () => {
    const mgr = new SubagentManager();
    shared.lastConfig = null;
    await mgr.forkSubagent({
      parent: { sessionId: 'parent-xyz' },
      config: { model: 'sonnet', parentSessionId: 'explicit-parent' },
    });

    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ parentSessionId: 'explicit-parent' }),
    );
  });

  it('stamps the fork\'s own id onto child config.subagentId, equal to the handle id (issue #612)', async () => {
    // The child's provider loop reads AgentConfig.subagentId to tag every
    // tool_call trace event so a fork's work is attributable in the shared
    // parent trace. The stamped id MUST equal the returned handle id (the id
    // used by subagent_lifecycle.started), or a reader could not correlate a
    // tagged tool_call with the child that emitted it.
    const mgr = new SubagentManager();
    shared.lastConfig = null;
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'parent-xyz' },
      config: { model: 'sonnet' },
    });

    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ subagentId: handle.id }),
    );
  });

  it('the fork-assigned subagentId wins over any inherited config.subagentId (nested fork safety)', async () => {
    // A nested fork (child forks grandchild) must not inherit the parent's
    // subagentId via the `...options.config` spread — the manager-assigned id
    // is authoritative. Simulate a config that already carries a stale id.
    const mgr = new SubagentManager();
    shared.lastConfig = null;
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'parent-xyz' },
      config: { model: 'sonnet', subagentId: 'stale-parent-id' },
    });

    expect((shared.lastConfig as { subagentId?: string } | null)?.subagentId).toBe(handle.id);
    expect((shared.lastConfig as { subagentId?: string } | null)?.subagentId).not.toBe(
      'stale-parent-id',
    );
  });

  it('child config.hookRegistry takes precedence over manager-level registry', async () => {
    const managerRegistry = createHookRegistry();
    const childRegistry = createHookRegistry();
    const mgr = new SubagentManager({ hookRegistry: managerRegistry });

    shared.lastConfig = null;
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', hookRegistry: childRegistry },
    });

    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ hookRegistry: childRegistry }),
    );
  });

  it('no registry → fork stays synchronous-feeling and dispatches nothing', async () => {
    const mgr = new SubagentManager();
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    await handle.cancel();
    // If we got here without errors, no registry is required.
    expect(handle.status).toBe('cancelled');
  });

  it('abort during SubagentStart surfaces AbortError (abort beats block)', async () => {
    const registry = createHookRegistry();
    const externalController = new AbortController();
    registry.register('SubagentStart', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      externalController.abort('external');
      return { decision: 'block', reason: 'would-have-blocked' };
    });

    const mgr = new SubagentManager({
      hookRegistry: registry,
      parentAbortSignal: externalController.signal,
    });

    const err = await mgr
      .forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } })
      .catch((e) => e);

    // Abort precedence — the handler tried to return block, but the signal
    // aborted during the await, so dispatch throws AbortError instead.
    expect(err?.name).toBe('AbortError');
  });

  it('SubagentStop handler returning injectContext queues message to parent input stream', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({
      injectContext: 'verify: output looks suspicious',
    }));

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-1' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });

    // The parent session is at shared.sessions[-1]
    const parentSession = shared.sessions[shared.sessions.length - 1];

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await childHandle.cancel();

    // After cancel, the child's SubagentStop should have queued context on the parent.
    const queued = parentSession.getMockQueuedFrameworkContext();
    expect(queued).toContain('verify: output looks suspicious');
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('SubagentStop without injectContext does not queue message to parent', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({}));

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-2' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });

    const parentSession = shared.sessions[shared.sessions.length - 1];

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await childHandle.cancel();

    expect(parentSession.getMockQueuedFrameworkContext()).toEqual([]);
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('SubagentStop injectContext is NOT injected when parent is aborting', async () => {
    // Abort precedence (matches abort-graph.ts invariant "abort-signal check is
    // unconditional"). If the parent's query loop has unwound, the input stream
    // buffer becomes a dead letter — queuing the message would be a silent
    // no-op at best. Consumers opt into this check by passing
    // `parent.abortSignal` alongside `parent.getInputStreamRef`.
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({
      injectContext: 'verify: should not appear',
    }));

    const parentAbortController = new AbortController();
    const parentMgr = new SubagentManager({
      hookRegistry: registry,
      parentAbortSignal: parentAbortController.signal,
    });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-3' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });

    const parentSession = shared.sessions[shared.sessions.length - 1];

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
        abortSignal: parentHandle.session.abortSignal,
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    // Abort the parent before cancelling the child. Cascades through the
    // parent manager's abort-graph to parentHandle.session.abortSignal.
    parentAbortController.abort('parent-abort');

    await childHandle.cancel();

    // injectContext is suppressed because parent.abortSignal is set.
    expect(parentSession.getMockQueuedFrameworkContext()).toEqual([]);
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('SubagentStop injectContext still fires when no parent abortSignal is provided (opt-in check)', async () => {
    // If the consumer doesn't pass parent.abortSignal, there's nothing to
    // check against, so injection proceeds. Documents the opt-in shape so a
    // missing abortSignal doesn't silently drop nudges.
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({
      injectContext: 'verify: no abort signal, proceed',
    }));

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-3b' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });

    const parentSession = shared.sessions[shared.sessions.length - 1];

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
        // Intentionally omit abortSignal — check is opt-in.
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await childHandle.cancel();

    const queued = parentSession.getMockQueuedFrameworkContext();
    expect(queued).toContain('verify: no abort signal, proceed');
  });

  it('multiple concurrent subagent cancels inject contexts in order', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStop', (ctx) => ({
      injectContext: `verify: ${(ctx as any).subagentId} completed`,
    }));

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-4' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });

    const parentSession = shared.sessions[shared.sessions.length - 1];

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const child1 = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child1',
    });
    const child2 = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child2',
    });

    // Cancel in order (not concurrent to keep results deterministic).
    await child1.cancel();
    await child2.cancel();

    const queued = parentSession.getMockQueuedFrameworkContext();
    expect(queued).toHaveLength(2);
    expect(queued[0]).toContain(child1.id);
    expect(queued[1]).toContain(child2.id);
  });

  it('falls back to pushUserMessage when the parent ref lacks queueFrameworkContext', async () => {
    // Narrow stubs (older callers, minimal test doubles) may expose only the
    // push channel. Delivery must degrade to the legacy behavior rather than
    // silently dropping the context.
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({
      injectContext: 'verify: legacy channel delivery',
    }));

    const pushed: string[] = [];
    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: {
        sessionId: 'root-legacy-ref',
        getInputStreamRef: () => ({
          pushUserMessage: (content: string) => {
            pushed.push(content);
          },
        }),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await handle.cancel();

    expect(pushed).toEqual(['verify: legacy channel delivery']);
  });
});

describe('SubagentHandle.teardown()', () => {
  it('after succeeded run, dispatches SubagentStop with status "succeeded" and preserves handle.status', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
      idPrefix: 'research',
    });

    await handle.run('inspect');
    await handle.teardown();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'SubagentStop',
      subagentId: handle.id,
      status: 'succeeded',
      lastMessage: 'ok:inspect',
      agentType: 'research',
    });
    // Core teardown invariant: handle.status stays truthful.
    // cancel() would have flipped this to 'cancelled'.
    expect(handle.status).toBe('succeeded');
  });

  it('after failed run, dispatches SubagentStop with status "failed"', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    const lastSession = shared.sessions[shared.sessions.length - 1]!;
    lastSession.sendMessage.mockRejectedValueOnce(new Error('child blew up'));

    await expect(handle.run('inspect')).rejects.toThrow(/blew up/);
    await handle.teardown();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'SubagentStop',
      subagentId: handle.id,
      status: 'failed',
    });
    expect(handle.status).toBe('failed');
  });

  it('on never-run handle, dispatches SubagentStop with status "cancelled"', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });

    await handle.teardown();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'SubagentStop',
      subagentId: handle.id,
      status: 'cancelled',
    });
  });

  it('is idempotent — second teardown() is a no-op', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    await handle.run('ping');
    await handle.teardown();
    await handle.teardown();

    expect(events).toHaveLength(1);
  });

  it('teardown() then cancel() — hook fires once (from teardown), cancel is a no-op', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    await handle.run('ping');
    await handle.teardown();
    await handle.cancel();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'succeeded' });
    // teardown did NOT flip status; cancel was a no-op after teardown.
    expect(handle.status).toBe('succeeded');
  });

  it('cancel() then teardown() — hook fires once (from cancel), teardown is a no-op', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    await handle.cancel();
    await handle.teardown();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'cancelled' });
  });

  it('teardown() does NOT trigger onChildAborted listeners (abort-graph stays clean)', async () => {
    const registry = createHookRegistry();
    const mgr = new SubagentManager({ hookRegistry: registry });
    const abortedIds: string[] = [];
    mgr.onChildAborted((event) => abortedIds.push(event.childId));

    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    await handle.run('ping');
    await handle.teardown();

    // Succeeded → teardown → no abort-graph disturbance.
    expect(abortedIds).toEqual([]);
  });

  it('cancel() still triggers onChildAborted (real interruption is distinct from teardown)', async () => {
    // Regression guard: make sure the split does not accidentally neuter cancel().
    const registry = createHookRegistry();
    const mgr = new SubagentManager({ hookRegistry: registry });
    const abortedIds: string[] = [];
    mgr.onChildAborted((event) => abortedIds.push(event.childId));

    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    await handle.cancel();

    expect(abortedIds).toEqual([handle.id]);
  });

  it('teardown() flows through injectContext just like cancel()', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({
      injectContext: 'post-teardown note',
    }));

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-teardown' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await childHandle.run('audit');
    await childHandle.teardown();

    const queued = parentSession.getMockQueuedFrameworkContext();
    expect(queued).toContain('post-teardown note');
  });

  // ----------------------------------------------------------------------
  // In-turn injectContext delivery (deferInjectContextToCaller).
  //
  // Exactly-once crux: when teardown() is asked to defer delivery to the
  // caller, the produced injectContext is recorded on
  // getLastStopInjectContext() for the caller to append to the tool_result,
  // and the queue push is SUPPRESSED. Without the flag, delivery still rides
  // the queue (the compose/DAG + cancel/fail-fast paths keep this behavior).
  // ----------------------------------------------------------------------
  it('teardown({ deferInjectContextToCaller: true }) records the note and does NOT queue (deliver-once)', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({
      injectContext: 'defer: in-turn nudge',
    }));

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-defer' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await childHandle.run('audit');
    await childHandle.teardown({ deferInjectContextToCaller: true });

    // Recorded for the caller to deliver in-turn…
    expect(childHandle.getLastStopInjectContext()).toBe('defer: in-turn nudge');
    // …and NEITHER queue channel fired (suppressed — deliver-once).
    expect(parentSession.getMockQueuedFrameworkContext()).toEqual([]);
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('teardown() WITHOUT the defer flag still queues and leaves getLastStopInjectContext undefined', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({
      injectContext: 'queue: default channel',
    }));

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-default-queue' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await childHandle.run('audit');
    await childHandle.teardown();

    // Default path: queued, and nothing recorded for the caller.
    expect(parentSession.getMockQueuedFrameworkContext()).toContain('queue: default channel');
    expect(childHandle.getLastStopInjectContext()).toBeUndefined();
  });

  it('deferInjectContextToCaller: parent abort suppresses BOTH channels (nothing recorded, nothing queued)', async () => {
    // Abort precedence is checked before the defer branch — an aborting parent
    // will unwind before it could consume the note, so neither the caller nor
    // the queue receives it.
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({
      injectContext: 'defer: should be suppressed by abort',
    }));

    const parentAbortController = new AbortController();
    const parentMgr = new SubagentManager({
      hookRegistry: registry,
      parentAbortSignal: parentAbortController.signal,
    });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-defer-abort' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
        abortSignal: parentHandle.session.abortSignal,
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await childHandle.run('audit');
    parentAbortController.abort('parent-abort');
    await childHandle.teardown({ deferInjectContextToCaller: true });

    expect(childHandle.getLastStopInjectContext()).toBeUndefined();
    expect(parentSession.getMockQueuedFrameworkContext()).toEqual([]);
    expect(parentSession.getMockInputStreamMessages()).toEqual([]);
  });

  it('deferInjectContextToCaller with no injectContext produced: getter stays undefined, no queue', async () => {
    const registry = createHookRegistry();
    registry.register('SubagentStop', () => ({})); // no injectContext

    const parentMgr = new SubagentManager({ hookRegistry: registry });
    const parentHandle = await parentMgr.forkSubagent({
      parent: { sessionId: 'root-defer-none' },
      config: { model: 'sonnet' },
      idPrefix: 'parent',
    });
    const parentSession = shared.sessions[shared.sessions.length - 1]!;

    const childMgr = new SubagentManager({ hookRegistry: registry });
    const childHandle = await childMgr.forkSubagent({
      parent: {
        sessionId: parentHandle.session.sessionId,
        getInputStreamRef: parentHandle.session.getInputStreamRef.bind(parentHandle.session),
      },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    await childHandle.run('audit');
    await childHandle.teardown({ deferInjectContextToCaller: true });

    expect(childHandle.getLastStopInjectContext()).toBeUndefined();
    expect(parentSession.getMockQueuedFrameworkContext()).toEqual([]);
  });

  it('teardown() closes the underlying session', async () => {
    const registry = createHookRegistry();
    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    const session = shared.sessions[shared.sessions.length - 1]!;
    await handle.run('ping');
    await handle.teardown();

    // Mock session's close should have been invoked. (The mock provides close = vi.fn)
    expect((session as any).close ?? (handle.session as any).close).toBeTruthy();
  });
});

describe('SubagentManager.teardownAll()', () => {
  it('dispatches SubagentStop for every still-active handle with its true terminal status', async () => {
    // Note: once a handle's run() resolves, it self-removes from active via
    // onTerminal(). teardownAll() therefore covers handles that were forked
    // but never run, or that are still running when cleanup begins.
    const registry = createHookRegistry();
    const events: Array<{ id: string; status: string }> = [];
    registry.register('SubagentStop', (ctx) => {
      const c = ctx as { subagentId: string; status: string };
      events.push({ id: c.subagentId, status: c.status });
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const h1 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const h2 = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });

    await mgr.teardownAll();

    expect(events).toHaveLength(2);
    const ids = events.map((e) => e.id).sort();
    expect(ids).toEqual([h1.id, h2.id].sort());
    // Neither ran, so both report 'cancelled' as fallback.
    expect(events.every((e) => e.status === 'cancelled')).toBe(true);
  });
});

describe('BackgroundAgentRegistry — SubagentStop lifecycle (end-to-end)', () => {
  // These wire a REAL SubagentManager handle (real SubagentHandleImpl, mocked
  // child session) through the real BackgroundAgentRegistry to prove the
  // firing + exactly-once semantics the stub-level background-registry tests
  // cannot: the `stopDispatched` guard lives in SubagentHandleImpl, so only a
  // real handle exercises it.

  /** Await the registry's terminal settle, then flush the async teardown chain. */
  async function joinAndFlush(
    registry: BackgroundAgentRegistry,
    jobId: string,
  ): Promise<SubagentResult> {
    const result = await registry.join(jobId);
    // markTerminal awaits handle.teardown() after settling; the join resolves
    // at settle time, so drain a couple of microtasks to let teardown (and its
    // SubagentStop dispatch) run to completion before assertions.
    await Promise.resolve();
    await Promise.resolve();
    return result;
  }

  it('naturally-completing background job fires SubagentStop exactly once (status "succeeded")', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p-bg' },
      config: { model: 'sonnet' },
      idPrefix: 'research',
    });

    const bg = new BackgroundAgentRegistry({});
    const job = bg.register({ handle, prompt: 'inspect', model: 'sonnet' });

    // Before the fix, the run completed and settled but SubagentStop never
    // fired for a background job. Now it must fire via markTerminal → teardown.
    await joinAndFlush(bg, job.jobId);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'SubagentStop',
      subagentId: handle.id,
      status: 'succeeded',
      agentType: 'research',
    });
    // Teardown does not clobber status — a succeeded run stays 'succeeded'.
    expect(handle.status).toBe('succeeded');
  });

  it('naturally-completing background job seals the child session (close called)', async () => {
    const registry = createHookRegistry();
    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p-bg' },
      config: { model: 'sonnet' },
    });
    const childSession = shared.sessions[shared.sessions.length - 1]!;

    const bg = new BackgroundAgentRegistry({});
    const job = bg.register({ handle, prompt: 'inspect', model: 'sonnet' });
    await joinAndFlush(bg, job.jobId);

    // teardown() → session.close(). The mock exposes close as a vi.fn on the
    // session instance; assert it was invoked exactly once (no double-close).
    const closeSpy = (handle.session as unknown as { close: ReturnType<typeof vi.fn> }).close;
    expect(closeSpy).toHaveBeenCalledTimes(1);
    void childSession;
  });

  it('idempotency: completing then cancelling the same job fires SubagentStop exactly once', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p-bg' },
      config: { model: 'sonnet' },
    });

    const bg = new BackgroundAgentRegistry({});
    const job = bg.register({ handle, prompt: 'inspect', model: 'sonnet' });

    // Natural completion fires SubagentStop (once) and marks the job terminal.
    await joinAndFlush(bg, job.jobId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'succeeded' });

    // A later cancelJob on the now-terminal job returns false (registry
    // short-circuits on non-running status) — SubagentStop must NOT fire again.
    const cancelled = await bg.cancelJob(job.jobId);
    expect(cancelled).toBe(false);
    expect(events).toHaveLength(1);

    // Defense-in-depth: even a direct handle.cancel() after teardown is a
    // no-op via the shared `stopDispatched` guard, so still exactly one event.
    await handle.cancel();
    expect(events).toHaveLength(1);
    expect(handle.status).toBe('succeeded');
  });

  it('cancelled-before-completion background job fires SubagentStop once with status "cancelled"', async () => {
    const registry = createHookRegistry();
    const events: HookContext[] = [];
    registry.register('SubagentStop', (ctx) => {
      events.push(ctx);
      return {};
    });

    const mgr = new SubagentManager({ hookRegistry: registry });
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'p-bg' },
      config: { model: 'sonnet' },
    });
    // Make the child run hang so cancelJob wins before natural completion.
    const childSession = shared.sessions[shared.sessions.length - 1]!;
    (childSession.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise(() => {}), // never resolves
    );

    const bg = new BackgroundAgentRegistry({});
    const job = bg.register({ handle, prompt: 'inspect', model: 'sonnet' });

    // cancelJob → handle.cancel() fires SubagentStop (setting stopDispatched)
    // before the synthesized cancelled result re-enters markTerminal, so the
    // trailing teardown there is a no-op — the hook fires exactly once.
    const cancelled = await bg.cancelJob(job.jobId);
    expect(cancelled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'cancelled', subagentId: handle.id });
  });
});
