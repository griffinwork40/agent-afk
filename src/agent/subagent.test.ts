/**
 * Tests for SubagentManager — dispatch, permission bubbling, abort graph,
 * Zod output schemas, transitive cancel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { Message } from './types.js';

type CapturedConfig = Record<string, unknown> | null;

interface SessionState {
  config: Record<string, unknown>;
  replyContent: string | ((prompt: string) => string);
  replyDelayMs: number;
}

const shared = vi.hoisted(() => ({
  lastConfig: null as CapturedConfig,
  sessions: [] as Array<{
    state: SessionState;
    sendMessage: ReturnType<typeof vi.fn>;
  }>,
  /** When true, the next AgentSession constructor invocation throws synchronously. */
  throwOnNextConstruction: false,
}));

vi.mock('./session.js', () => {
  class MockAgentSession {
    public readonly sessionId?: string;
    private readonly state: SessionState;
    public sendMessage: ReturnType<typeof vi.fn>;
    public sendMessageStream: ReturnType<typeof vi.fn>;
    public interrupt = vi.fn(async () => undefined);
    public close = vi.fn(async () => undefined);
    constructor(config: Record<string, unknown>) {
      if (shared.throwOnNextConstruction) {
        shared.throwOnNextConstruction = false;
        throw new Error('simulated AgentSession constructor failure (invalid model)');
      }
      shared.lastConfig = config;
      this.sessionId = (config.sessionId as string | undefined) ?? 'child-session-id';
      this.state = { config, replyContent: '', replyDelayMs: 0 };
      this.sendMessage = vi.fn(async (content: string): Promise<Message> => {
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
      // Streaming version: call sendMessage to match mocking behavior, then emit
      this.sendMessageStream = vi.fn(async function* (content: string) {
        const result = await this.sendMessage(content);
        yield { type: 'message', message: result };
        yield { type: 'done' };
      }.bind(this));
      shared.sessions.push({ state: this.state, sendMessage: this.sendMessage });
    }
    get abortSignal(): AbortSignal {
      return (this.state.config.abortSignal as AbortSignal) ?? new AbortController().signal;
    }
  }
  return { AgentSession: MockAgentSession };
});

import {
  SubagentManager,
  SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  SUBAGENT_BACKGROUND_TIMEOUT_MS,
  resolveSubagentTimeoutMs,
} from './subagent.js';

function lastSessionState(): SessionState {
  return shared.sessions[shared.sessions.length - 1].state;
}

function lastSessionAbortSignal(): AbortSignal {
  const state = lastSessionState();
  return (state.config.abortSignal as AbortSignal) ?? new AbortController().signal;
}

describe('SubagentManager', () => {
  it('forks from parent sessionId by setting resume+forkSession', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    const handle = await mgr.forkSubagent({
      parent: { sessionId: 'parent-session-123' },
      config: { model: 'sonnet' },
      idPrefix: 'child',
    });

    expect(handle.id.startsWith('child-')).toBe(true);
    expect(shared.lastConfig).toEqual(expect.objectContaining({ resume: 'parent-session-123', forkSession: true }));

    const msg = await handle.run('hello');
    expect(msg.content).toBe('ok:hello');
    expect(handle.status).toBe('succeeded');
  });

  it('creates a fresh session when parent has no sessionId', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: undefined },
      config: { model: 'sonnet' },
    });

    expect(shared.lastConfig).toEqual(expect.objectContaining({ resume: undefined, forkSession: undefined }));
  });

  it('injects permissionBubbler when manager has canUseTool and child has none', async () => {
    shared.lastConfig = null;
    const canUseTool = vi.fn();
    const mgr = new SubagentManager({ canUseTool });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });

    expect(shared.lastConfig).toEqual(
      expect.objectContaining({
        permissionBubbler: expect.objectContaining({ canUseTool }),
      }),
    );
  });

  it('does not override an explicit canUseTool on the child', async () => {
    shared.lastConfig = null;
    const parentHook = vi.fn();
    const childHook = vi.fn();
    const mgr = new SubagentManager({ canUseTool: parentHook });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', canUseTool: childHook },
    });

    // Child has its own canUseTool — permissionBubbler must NOT be set
    expect((shared.lastConfig as unknown as Record<string, unknown>)['permissionBubbler']).toBeUndefined();
    expect(shared.lastConfig).toEqual(expect.objectContaining({ canUseTool: childHook }));
  });

  // Local-mode propagation: when a session is hitting a local Anthropic-
  // compatible server, child sessions must inherit the same `baseUrl` or
  // they will silently fall back to api.anthropic.com.
  it('inherits baseUrl from manager when child config omits it', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager({ baseUrl: 'http://127.0.0.1:8080' });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'local-qwen-3-6' },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ baseUrl: 'http://127.0.0.1:8080' }),
    );
  });

  // Anti-hang: every fork gets a positive tool-use-iteration ceiling so a
  // runaway child cannot spin unbounded on anthropic-direct (whose provider
  // default is 0 = no cap) while the parent is suspended awaiting its result.
  it('applies the default tool-use-iteration cap when child config omits it', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    // Pin parity with openai-compatible's built-in 50-round cap.
    expect(SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS).toBe(50);
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({
        maxToolUseIterations: SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
      }),
    );
  });

  it('preserves an explicit maxToolUseIterations override on the child config', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', maxToolUseIterations: 7 },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ maxToolUseIterations: 7 }),
    );
  });

  it('preserves an explicit maxToolUseIterations of 0 (opt back into unbounded)', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', maxToolUseIterations: 0 },
    });
    expect((shared.lastConfig as unknown as Record<string, unknown>)['maxToolUseIterations']).toBe(0);
  });

  // Anti-hang (sibling of the iteration cap): a fork that hits an OAuth
  // usage-limit 429 must FAIL FAST with the classified error, not silently
  // auto-pause and poll for reset (up to 2h in retry-layer.ts) while its
  // parent looks frozen. A fork has no human to wait for — the parent decides
  // what happens next.
  it('defaults autoResumeOnUsageLimit to false on the child config', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    expect((shared.lastConfig as unknown as Record<string, unknown>)['autoResumeOnUsageLimit']).toBe(false);
  });

  it('preserves an explicit autoResumeOnUsageLimit: true (unattended flows opt back in)', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', autoResumeOnUsageLimit: true },
    });
    expect((shared.lastConfig as unknown as Record<string, unknown>)['autoResumeOnUsageLimit']).toBe(true);
  });

  // Isolation: AFK_MAX_TOOL_USE_ITERATIONS is a TOP-LEVEL-only escape hatch. The
  // fork path (subagent.ts) never reads it — it defaults to
  // SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS (50). Setting the env var must NOT
  // change a fork's default, or the top-level opt-in would silently leak into
  // every subagent and shrink their anti-hang ceiling.
  it('ignores AFK_MAX_TOOL_USE_ITERATIONS on the fork path (subagent default unchanged)', async () => {
    const original = process.env['AFK_MAX_TOOL_USE_ITERATIONS'];
    process.env['AFK_MAX_TOOL_USE_ITERATIONS'] = '3';
    try {
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' }, // omit → should get the SUBAGENT default, not env's 3
      });
      expect(shared.lastConfig).toEqual(
        expect.objectContaining({
          maxToolUseIterations: SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS,
        }),
      );
      // Explicit proof it did NOT pick up the env value.
      expect((shared.lastConfig as unknown as Record<string, unknown>)['maxToolUseIterations']).not.toBe(3);
    } finally {
      if (original !== undefined) process.env['AFK_MAX_TOOL_USE_ITERATIONS'] = original;
      else delete process.env['AFK_MAX_TOOL_USE_ITERATIONS'];
    }
  });

  // Cross-provider credential anti-leak (composition boundary).
  //
  // The agent-tool executor deliberately clears `apiKey`/`baseUrl` for
  // OpenAI-routed children (subagent-executor.ts), but the manager's
  // fallback used to be provider-blind (`config.apiKey || parentApiKey`) and
  // reintroduced the parent's Anthropic credential — which the OpenAI auth
  // resolver then used as its Tier-1 config key (openai-compatible/auth.ts),
  // shipping `sk-ant-…` as a Bearer to an OpenAI-shaped endpoint. These
  // tests exercise the REAL manager (only AgentSession is mocked) so the
  // fallback itself — not a mocked boundary above it — is under test.
  describe('cross-provider credential anti-leak (forkSubagent fallback)', () => {
    it('never hands an Anthropic parent apiKey to an OpenAI-routed child', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager({ apiKey: 'sk-ant-oat01-PARENT' });
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'gpt-5.5' },
        idPrefix: 'leak-check',
        agentType: 'leak-check',
      });
      const cfg = shared.lastConfig as Record<string, unknown>;
      expect(cfg['apiKey']).toBeUndefined();
      expect(cfg['apiKey']).not.toBe('sk-ant-oat01-PARENT');
    });

    it('never hands the parent Anthropic baseUrl to an OpenAI-routed child', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager({
        apiKey: 'sk-ant-oat01-PARENT',
        baseUrl: 'http://127.0.0.1:8080',
      });
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'gpt-5.5' },
        idPrefix: 'leak-check',
        agentType: 'leak-check',
      });
      const cfg = shared.lastConfig as Record<string, unknown>;
      expect(cfg['baseUrl']).toBeUndefined();
    });

    it('preserves an explicit child apiKey for an OpenAI-routed child (caller wins)', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager({ apiKey: 'sk-ant-oat01-PARENT' });
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'gpt-5.5', apiKey: 'sk-proj-EXPLICIT' },
        idPrefix: 'leak-check',
        agentType: 'leak-check',
      });
      expect(shared.lastConfig).toEqual(
        expect.objectContaining({ apiKey: 'sk-proj-EXPLICIT' }),
      );
    });

    it('lets an OpenAI-shaped parent key flow to an OpenAI-routed child when parentModel marks the parent OpenAI (same-provider inheritance)', async () => {
      // parentModel is what every production manager supplies (chat/bootstrap/
      // telegram/compose all pass it): it makes parentProvider exact so the
      // same-provider inheritance is allowed. Without it, inheritance fails
      // closed — see the #438 test below.
      shared.lastConfig = null;
      const mgr = new SubagentManager({ apiKey: 'sk-proj-PARENT', parentModel: 'gpt-5.5' });
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'gpt-5.5' },
        idPrefix: 'inherit-check',
        agentType: 'inherit-check',
      });
      expect(shared.lastConfig).toEqual(
        expect.objectContaining({ apiKey: 'sk-proj-PARENT' }),
      );
    });

    it('fails closed when an OpenAI-shaped parent key has no parentModel — no inherit in either direction (#438)', async () => {
      // Without parentModel the manager cannot prove the parent's provider, so a
      // non-sk-ant key is never inherited: this closes the reverse
      // (openai→anthropic) leak AND refuses the same-provider case until
      // parentModel is supplied. Both children below must be credential-less.
      shared.lastConfig = null;
      const mgrOpenAiChild = new SubagentManager({ apiKey: 'sk-proj-PARENT' });
      await mgrOpenAiChild.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'gpt-5.5' },
        idPrefix: 'inherit-check',
        agentType: 'inherit-check',
      });
      expect((shared.lastConfig as Record<string, unknown>)['apiKey']).toBeUndefined();

      shared.lastConfig = null;
      const mgrAnthropicChild = new SubagentManager({ apiKey: 'sk-proj-PARENT' });
      await mgrAnthropicChild.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
        idPrefix: 'inherit-check',
        agentType: 'inherit-check',
      });
      expect((shared.lastConfig as Record<string, unknown>)['apiKey']).toBeUndefined();
    });

    it('still inherits the Anthropic parent apiKey + baseUrl for an Anthropic-routed child', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager({
        apiKey: 'sk-ant-oat01-PARENT',
        baseUrl: 'http://127.0.0.1:8080',
      });
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
        idPrefix: 'inherit-check',
        agentType: 'inherit-check',
      });
      expect(shared.lastConfig).toEqual(
        expect.objectContaining({
          apiKey: 'sk-ant-oat01-PARENT',
          baseUrl: 'http://127.0.0.1:8080',
        }),
      );
    });

    // Reverse direction: an OpenAI operator session (parentModel routes to
    // openai-compatible, so parentApiKey is an OpenAI key) must NOT hand that
    // key to an Anthropic-routed child. `parentModel` is the provider source of
    // truth; without it the key-shape guard could not catch this.
    it('never hands an OpenAI parent apiKey to an Anthropic-routed child (parentModel gate)', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager({ apiKey: 'sk-proj-PARENT', parentModel: 'gpt-5.5' });
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
        idPrefix: 'reverse-leak-check',
        agentType: 'reverse-leak-check',
      });
      const cfg = shared.lastConfig as Record<string, unknown>;
      expect(cfg['apiKey']).toBeUndefined();
      expect(cfg['apiKey']).not.toBe('sk-proj-PARENT');
    });

    it('still lets an OpenAI parent apiKey flow to an OpenAI-routed child (same provider, parentModel set)', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager({ apiKey: 'sk-proj-PARENT', parentModel: 'gpt-5.5' });
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'gpt-5.5' },
        idPrefix: 'inherit-check',
        agentType: 'inherit-check',
      });
      expect(shared.lastConfig).toEqual(
        expect.objectContaining({ apiKey: 'sk-proj-PARENT' }),
      );
    });
  });

  it('lets explicit child baseUrl override the manager default', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager({ baseUrl: 'http://127.0.0.1:8080' });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'local-qwen-3-6', baseUrl: 'http://other:9000' },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ baseUrl: 'http://other:9000' }),
    );
  });

  // Worktree-cwd propagation. When `afk i --worktree` creates a sibling
  // worktree, the interactive bootstrap constructs the root SubagentManager
  // with `cwd: <worktreePath>`. Forked subagents must inherit that cwd so
  // their tool handlers anchor `resolveBase` + `readRoots` to the worktree,
  // not the Node host's `process.cwd()` (which is the parent repo). Without
  // this inheritance, `read_file('src/foo.ts')` inside a subagent silently
  // reads the parent repo's file instead of the worktree's.
  it('inherits cwd from manager when child config omits it', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager({ cwd: '/tmp/wt/feat-x' });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ cwd: '/tmp/wt/feat-x' }),
    );
  });

  it('lets explicit child cwd override the manager default', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager({ cwd: '/tmp/wt/feat-x' });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', cwd: '/tmp/wt/feat-y' },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ cwd: '/tmp/wt/feat-y' }),
    );
  });

  it('omits cwd on child when neither manager nor child config set it', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    expect((shared.lastConfig as unknown as Record<string, unknown>)['cwd']).toBeUndefined();
  });

  // setCwd re-anchors forks mid-session. A born-named `afk -w` worktree is
  // created on turn 1, AFTER the root manager was constructed in the launch
  // dir; without re-anchoring, forked subagents keep inheriting the launch dir.
  it('forkSubagent inherits the updated cwd after setCwd (mid-session re-anchor)', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager({ cwd: '/tmp/launch/dir' });
    mgr.setCwd('/tmp/launch/dir/.afk-worktrees/afk-xyz');
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ cwd: '/tmp/launch/dir/.afk-worktrees/afk-xyz' }),
    );
  });

  // -------------------------------------------------------------------------
  // traceWriter + surface inheritance (witness layer / origin attribution)
  // Mirrors the cwd inheritance tests above: manager-level values propagate
  // into child AgentConfig so farm/DAG workers report the correct trace origin
  // without per-call plumbing.
  // -------------------------------------------------------------------------

  it('inherits traceWriter from manager when child config omits it', async () => {
    shared.lastConfig = null;
    const fakeWriter = { write: vi.fn(), close: vi.fn(), getTracePath: vi.fn() };
    const mgr = new SubagentManager({ traceWriter: fakeWriter as unknown as import('./trace/index.js').TraceWriter });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ traceWriter: fakeWriter }),
    );
  });

  it('lets explicit child traceWriter override the manager default', async () => {
    shared.lastConfig = null;
    const managerWriter = { write: vi.fn(), close: vi.fn(), getTracePath: vi.fn() };
    const childWriter = { write: vi.fn(), close: vi.fn(), getTracePath: vi.fn() };
    const mgr = new SubagentManager({
      traceWriter: managerWriter as unknown as import('./trace/index.js').TraceWriter,
    });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: {
        model: 'sonnet',
        traceWriter: childWriter as unknown as import('./trace/index.js').TraceWriter,
      },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ traceWriter: childWriter }),
    );
  });

  it('omits traceWriter on child when neither manager nor child config set it', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    expect((shared.lastConfig as unknown as Record<string, unknown>)['traceWriter']).toBeUndefined();
  });

  it('inherits surface from manager when child config omits it', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager({ surface: 'cli' });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ surface: 'cli' }),
    );
  });

  it('lets explicit child surface override the manager default', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager({ surface: 'cli' });
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet', surface: 'daemon' },
    });
    expect(shared.lastConfig).toEqual(
      expect.objectContaining({ surface: 'daemon' }),
    );
  });

  it('omits surface on child when neither manager nor child config set it', async () => {
    shared.lastConfig = null;
    const mgr = new SubagentManager();
    await mgr.forkSubagent({
      parent: { sessionId: 'p' },
      config: { model: 'sonnet' },
    });
    expect((shared.lastConfig as unknown as Record<string, unknown>)['surface']).toBeUndefined();
  });

  it('list() and get() track active handles', async () => {
    const mgr = new SubagentManager();
    const h = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get(h.id)).toBe(h);
  });

  it('kill() cancels and removes a handle', async () => {
    const mgr = new SubagentManager();
    const h = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    const removed = await mgr.kill(h.id);
    expect(removed).toBe(true);
    expect(mgr.list()).toHaveLength(0);
    expect(h.status).toBe('cancelled');
  });

  it('kill() returns false for unknown id', async () => {
    const mgr = new SubagentManager();
    const removed = await mgr.kill('does-not-exist');
    expect(removed).toBe(false);
  });

  it('run() throws when already cancelled', async () => {
    const mgr = new SubagentManager();
    const h = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
    await h.cancel();
    await expect(h.run('anything')).rejects.toThrow(/cancelled/);
  });

  it('runInBackground delivers result via callback', async () => {
    const mgr = new SubagentManager();
    const h = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });

    await new Promise<void>((resolve) => {
      h.runInBackground('ping', (result) => {
        expect(result.status).toBe('succeeded');
        expect(result.message?.content).toBe('ok:ping');
        resolve();
      });
    });
  });

  describe('Zod output schemas', () => {
    const fileSchema = z.object({ files_changed: z.array(z.string()) });

    it('returns typed output on schema match (fenced JSON)', async () => {
      const mgr = new SubagentManager();
      const h = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
        outputSchema: fileSchema,
      });
      lastSessionState().replyContent = 'some prose\n\n```json\n{"files_changed": ["a.ts", "b.ts"]}\n```\n';

      const result = await h.runToResult('do the thing');

      expect(result.status).toBe('succeeded');
      expect(result.output).toEqual({ files_changed: ['a.ts', 'b.ts'] });
      expect(result.schemaError).toBeUndefined();
    });

    it('surfaces schemaError when output fails validation', async () => {
      const mgr = new SubagentManager();
      const h = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
        outputSchema: fileSchema,
      });
      lastSessionState().replyContent = 'wrong shape: ```json\n{"files": 3}\n```';

      const result = await h.runToResult('do the thing');

      expect(result.status).toBe('failed');
      expect(result.output).toBeUndefined();
      expect(result.schemaError).toBeDefined();
      expect(result.error?.message).toMatch(/structured output did not match schema/);
    });

    it('skips parsing when no outputSchema is set', async () => {
      const mgr = new SubagentManager();
      const h = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
      lastSessionState().replyContent = 'totally unstructured';

      const result = await h.runToResult('hi');

      expect(result.status).toBe('succeeded');
      expect(result.output).toBeUndefined();
      expect(result.schemaError).toBeUndefined();
      expect(result.message?.content).toBe('totally unstructured');
    });
  });

  describe('abort graph / transitive cancel', () => {
    it('forks with an abortSignal propagating from the manager root', async () => {
      const mgr = new SubagentManager();
      await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
      const signal = lastSessionAbortSignal();

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);

      mgr.abortAll('shutdown');
      expect(signal.aborted).toBe(true);
    });

    it('parent abort cascades to a nested (grandchild) manager', async () => {
      const parentMgr = new SubagentManager();
      const child = await parentMgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
      const childSignal = lastSessionAbortSignal();

      // Nested manager wired to the child's signal — simulates grandchild forking
      const nestedMgr = new SubagentManager({ parentAbortSignal: childSignal });
      await nestedMgr.forkSubagent({ parent: { sessionId: child.id }, config: { model: 'sonnet' } });
      const grandchildSignal = lastSessionAbortSignal();

      expect(grandchildSignal.aborted).toBe(false);

      parentMgr.abortAll('parent-shutdown');

      expect(childSignal.aborted).toBe(true);
      expect(grandchildSignal.aborted).toBe(true);
    });

    it('onChildAborted fires when a subagent is externally cancelled', async () => {
      const mgr = new SubagentManager();
      const h = await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
      const listener = vi.fn();
      mgr.onChildAborted(listener);

      await h.cancel();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ childId: h.id, reason: 'cancelled' }),
      );
    });

    it('abortAll does not fire onChildAborted (children are cascades, not externals)', async () => {
      const mgr = new SubagentManager();
      await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
      await mgr.forkSubagent({ parent: { sessionId: 'p' }, config: { model: 'sonnet' } });
      const listener = vi.fn();
      mgr.onChildAborted(listener);

      mgr.abortAll();

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('timeouts', () => {
    it('cancels the controller when a subagent run times out', async () => {
      const mgr = new SubagentManager();
      const h = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', timeoutMs: 20 },
      });
      lastSessionState().replyDelayMs = 500;
      const signal = lastSessionAbortSignal();

      await expect(h.run('slow')).rejects.toThrow(/timed out/);
      expect(signal.aborted).toBe(true);
      // Own-budget timeout is a failure of THIS run, not an external teardown:
      // status must be 'failed' so runToResult → registry → notifier injection
      // delivers the timeout error the fork-budget contract promised (PR #596,
      // #465 follow-up). Cascaded (inherited) timeouts differ — see the
      // "cascaded TimeoutError abort" test in handle-streaming.test.ts.
      expect(h.status).toBe('failed');
    });

    // Anti-hang: forks default to a BOUNDED wall-clock budget. The session
    // default (DEFAULT_SESSION_TIMEOUT_MS = 0 = unbounded) is correct for
    // top-level sessions but let a stalled child — provider throttling, a
    // wedged stream, a slow-grinding tool loop — park its parent at
    // `await runToResult` indefinitely (observed in production: 4 parallel
    // children spun 29 minutes under a 429 cascade until manually cancelled).
    it('pins the fork budget defaults (45 min foreground / 60 min background)', () => {
      // Raised 20m → 45m (PR: env-configurable timeout): the 20-min wall
      // guillotined genuinely-working read-only research/review children
      // (e.g. /review's research-agent nesting git-investigator on a large
      // diff). 45m gives headroom over the longest healthy child observed
      // while still guaranteeing every fork terminates. Background is
      // unchanged. The foreground default is now also env-tunable via
      // AFK_SUBAGENT_TIMEOUT_MS (see resolveSubagentTimeoutMs tests below).
      expect(SUBAGENT_DEFAULT_TIMEOUT_MS).toBe(45 * 60_000);
      expect(SUBAGENT_BACKGROUND_TIMEOUT_MS).toBe(60 * 60_000);
    });

    it('applies SUBAGENT_DEFAULT_TIMEOUT_MS when child config omits timeoutMs', async () => {
      vi.useFakeTimers();
      try {
        const mgr = new SubagentManager();
        const h = await mgr.forkSubagent({
          parent: { sessionId: 'p' },
          config: { model: 'sonnet' }, // no timeoutMs → fork default applies
        });
        // Child never replies within the budget.
        lastSessionState().replyDelayMs = SUBAGENT_DEFAULT_TIMEOUT_MS + 60_000;
        const signal = lastSessionAbortSignal();

        const run = h.run('slow');
        // Reference the constant so this stays in lockstep with the default
        // (was hardcoded 1200000ms for the 20-min default; now 2700000ms).
        const rejection = expect(run).rejects.toThrow(
          new RegExp(`timed out after ${SUBAGENT_DEFAULT_TIMEOUT_MS}ms`),
        );
        await vi.advanceTimersByTimeAsync(SUBAGENT_DEFAULT_TIMEOUT_MS);
        await rejection;
        expect(signal.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves an explicit timeoutMs of 0 (opt back into unbounded)', async () => {
      vi.useFakeTimers();
      try {
        const mgr = new SubagentManager();
        const h = await mgr.forkSubagent({
          parent: { sessionId: 'p' },
          config: { model: 'sonnet', timeoutMs: 0 },
        });
        // Reply lands AFTER the would-be default budget — must still succeed.
        lastSessionState().replyDelayMs = SUBAGENT_DEFAULT_TIMEOUT_MS + 60_000;

        const run = h.run('slow');
        await vi.advanceTimersByTimeAsync(SUBAGENT_DEFAULT_TIMEOUT_MS + 61_000);
        const msg = await run;
        expect(msg.content).toBe('ok:slow');
      } finally {
        vi.useRealTimers();
      }
    });

    // resolveSubagentTimeoutMs is the DEFAULT resolver consulted by the fork
    // site (`config.timeoutMs ?? resolveSubagentTimeoutMs()`). Pure-function
    // contract, mirroring resolveTtfbTimeoutMs: unset/empty/invalid → default,
    // valid finite int >= 0 → that value, 0 → 0 (unbounded).
    describe('resolveSubagentTimeoutMs (AFK_SUBAGENT_TIMEOUT_MS)', () => {
      const KEY = 'AFK_SUBAGENT_TIMEOUT_MS';
      let original: string | undefined;
      beforeEach(() => {
        original = process.env[KEY];
        delete process.env[KEY];
      });
      afterEach(() => {
        if (original !== undefined) process.env[KEY] = original;
        else delete process.env[KEY];
      });

      it('returns SUBAGENT_DEFAULT_TIMEOUT_MS when unset', () => {
        expect(resolveSubagentTimeoutMs()).toBe(SUBAGENT_DEFAULT_TIMEOUT_MS);
      });

      it('returns SUBAGENT_DEFAULT_TIMEOUT_MS when empty / whitespace', () => {
        process.env[KEY] = '';
        expect(resolveSubagentTimeoutMs()).toBe(SUBAGENT_DEFAULT_TIMEOUT_MS);
        process.env[KEY] = '   ';
        expect(resolveSubagentTimeoutMs()).toBe(SUBAGENT_DEFAULT_TIMEOUT_MS);
      });

      it('parses a valid integer', () => {
        process.env[KEY] = '600000';
        expect(resolveSubagentTimeoutMs()).toBe(600_000);
      });

      it('treats 0 as the explicit unbounded escape hatch', () => {
        process.env[KEY] = '0';
        expect(resolveSubagentTimeoutMs()).toBe(0);
      });

      it('falls back to the default on a negative value', () => {
        process.env[KEY] = '-1';
        expect(resolveSubagentTimeoutMs()).toBe(SUBAGENT_DEFAULT_TIMEOUT_MS);
      });

      it('falls back to the default on unparseable garbage', () => {
        process.env[KEY] = 'not-a-number';
        expect(resolveSubagentTimeoutMs()).toBe(SUBAGENT_DEFAULT_TIMEOUT_MS);
      });
    });

    // Fork-site precedence: the env default is consulted ONLY when the caller
    // omits config.timeoutMs. An explicit config.timeoutMs (including 0 and the
    // background SUBAGENT_BACKGROUND_TIMEOUT_MS) still wins via the `??`.
    describe('AFK_SUBAGENT_TIMEOUT_MS at the fork site', () => {
      const KEY = 'AFK_SUBAGENT_TIMEOUT_MS';
      let original: string | undefined;
      beforeEach(() => {
        original = process.env[KEY];
      });
      afterEach(() => {
        if (original !== undefined) process.env[KEY] = original;
        else delete process.env[KEY];
      });

      it('applies the env override as the fork default when config omits timeoutMs', async () => {
        vi.useFakeTimers();
        try {
          process.env[KEY] = '5000'; // 5s — far below the 45m default
          const mgr = new SubagentManager();
          const h = await mgr.forkSubagent({
            parent: { sessionId: 'p' },
            config: { model: 'sonnet' }, // no timeoutMs → env override applies
          });
          // Never replies within the env budget.
          lastSessionState().replyDelayMs = 60_000;
          const signal = lastSessionAbortSignal();

          const run = h.run('slow');
          const rejection = expect(run).rejects.toThrow(/timed out after 5000ms/);
          await vi.advanceTimersByTimeAsync(5000);
          await rejection;
          expect(signal.aborted).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

      it('lets an explicit config.timeoutMs win over the env override', async () => {
        vi.useFakeTimers();
        try {
          process.env[KEY] = '5000'; // env says 5s…
          const mgr = new SubagentManager();
          const h = await mgr.forkSubagent({
            parent: { sessionId: 'p' },
            config: { model: 'sonnet', timeoutMs: 20_000 }, // …explicit 20s wins
          });
          // Reply lands after the env budget but before the explicit one.
          lastSessionState().replyDelayMs = 10_000;

          const run = h.run('slow');
          // Advancing past the env budget (5s) must NOT time out — explicit wins.
          await vi.advanceTimersByTimeAsync(11_000);
          const msg = await run;
          expect(msg.content).toBe('ok:slow');
        } finally {
          vi.useRealTimers();
        }
      });

      it('leaves the background carve-out unaffected (explicit 0 stays unbounded)', async () => {
        vi.useFakeTimers();
        try {
          process.env[KEY] = '5000'; // small env default…
          const mgr = new SubagentManager();
          const h = await mgr.forkSubagent({
            parent: { sessionId: 'p' },
            // Background dispatch stamps timeoutMs:0 (unbounded) — env must not
            // re-cap it. (0 is the SubagentExecutor's carve-out for bg mode.)
            config: { model: 'sonnet', timeoutMs: 0 },
          });
          lastSessionState().replyDelayMs = 60_000;

          const run = h.run('slow');
          await vi.advanceTimersByTimeAsync(61_000);
          const msg = await run;
          expect(msg.content).toBe('ok:slow');
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  // External constraint: a forked sub-agent has no human relationship of its
  // own, so every fork is non-interactive by default — DENY_ELICITATION is
  // installed on the child config so the SDK auto-declines MCP elicitations
  // instead of routing them to the operator. A caller opts a fork back in with
  // denyElicitations: false (then the parent's handler, if any, propagates).
  describe('denyElicitations / DENY_ELICITATION', () => {
    it('DENY_ELICITATION resolves to { action: "decline" } regardless of input', async () => {
      const { DENY_ELICITATION } = await import('./subagent.js');
      const ac = new AbortController();
      const result = await DENY_ELICITATION(
        { type: 'permission', message: 'any' } as any,
        { signal: ac.signal },
      );
      expect(result).toEqual({ action: 'decline' });
    });

    it('denyElicitations: true installs DENY_ELICITATION on childConfig.onElicitation', async () => {
      const { DENY_ELICITATION } = await import('./subagent.js');
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
        denyElicitations: true,
      });
      expect(shared.lastConfig?.onElicitation).toBe(DENY_ELICITATION);
    });

    it('denyElicitations: false (explicit opt-out) leaves onElicitation untouched', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
        denyElicitations: false,
      });
      // Explicit opt-out: no DENY_ELICITATION installed. No handler on the
      // parent config → child receives none.
      expect(shared.lastConfig?.onElicitation).toBeUndefined();
    });

    it('denyElicitations: true overrides a parent-provided onElicitation handler', async () => {
      const { DENY_ELICITATION } = await import('./subagent.js');
      const parentHandler = vi.fn();
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', onElicitation: parentHandler as any },
        denyElicitations: true,
      });
      // Override wins — bg children never route elicitations through a
      // parent-supplied handler, since the parent itself may not have
      // a live surface.
      expect(shared.lastConfig?.onElicitation).toBe(DENY_ELICITATION);
    });

    it('denyElicitations omitted: DENY_ELICITATION installed by default (overrides parent handler)', async () => {
      const { DENY_ELICITATION } = await import('./subagent.js');
      const parentHandler = vi.fn();
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', onElicitation: parentHandler as any },
        // denyElicitations omitted — forks now default to non-interactive, so
        // DENY_ELICITATION is installed unless the caller opts out with false.
      });
      // Default-deny: a fork is non-interactive by default, so even a
      // parent-provided handler is overridden. The parent owns the operator
      // relationship; the sub-agent reports findings back rather than eliciting.
      expect(shared.lastConfig?.onElicitation).toBe(DENY_ELICITATION);
    });

    it('denyElicitations: false (opt-out) lets a parent onElicitation propagate to the child', async () => {
      const parentHandler = vi.fn();
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', onElicitation: parentHandler as any },
        denyElicitations: false,
      });
      // Explicit opt-out preserves transitive inheritance via the
      // ...options.config spread (e.g. a parent that itself has a live surface).
      expect(shared.lastConfig?.onElicitation).toBe(parentHandler);
    });

    it('forked sub-agents are non-interactive by default (isNonInteractive omitted → true)', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
      });
      // The provider strips `ask_question` from a non-interactive toolset, so a
      // fork cannot prompt the operator via that tool either.
      expect(shared.lastConfig?.isNonInteractive).toBe(true);
    });

    it('isNonInteractive: false on the fork config is respected (caller opt-in to interactive)', async () => {
      shared.lastConfig = null;
      const mgr = new SubagentManager();
      await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet', isNonInteractive: false },
      });
      expect(shared.lastConfig?.isNonInteractive).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // [R4] AbortGraph node cleanup on AgentSession constructor failure
  // ---------------------------------------------------------------------------
  //
  // External constraint: AbortGraph nodes registered before child construction
  // must be released if construction fails — otherwise graph accumulates orphan
  // nodes across forge/farm runs that retry on misconfigured models.
  describe('[R4] AbortGraph cleanup when AgentSession constructor throws', () => {
    it('forkSubagent disposes the AbortGraph node when AgentSession constructor throws', async () => {
      // Track every register/dispose call on AbortGraph instances so we can
      // verify that any id registered before the throwing construction is also
      // disposed (i.e. no orphan node remains after a failed fork).
      const { AbortGraph: AG } = await import('./abort-graph.js');
      const registered: string[] = [];
      const disposed: string[] = [];

      const origRegister = AG.prototype.register;
      const origDispose = AG.prototype.dispose;

      vi.spyOn(AG.prototype, 'register').mockImplementation(function (
        this: InstanceType<typeof AG>,
        id: string,
        controller: AbortController,
      ) {
        registered.push(id);
        return origRegister.call(this, id, controller);
      });

      vi.spyOn(AG.prototype, 'dispose').mockImplementation(function (
        this: InstanceType<typeof AG>,
        id: string,
      ) {
        disposed.push(id);
        return origDispose.call(this, id);
      });

      // Capture the manager's AbortGraph instance so we can probe parent→child
      // links after the failed fork.
      let capturedGraph: InstanceType<typeof AG> | undefined;
      const origLinkChild = AG.prototype.linkChild;
      vi.spyOn(AG.prototype, 'linkChild').mockImplementation(function (
        this: InstanceType<typeof AG>,
        parentId: string,
        childId: string,
      ) {
        capturedGraph = this;
        return origLinkChild.call(this, parentId, childId);
      });

      // Arm the module-level mock: next AgentSession construction will throw.
      shared.throwOnNextConstruction = true;

      const mgr = new SubagentManager();

      // forkSubagent must reject (construction failed).
      await expect(
        mgr.forkSubagent({
          parent: { sessionId: 'p' },
          config: { model: 'invalid-model-that-triggers-sync-throw' },
          idPrefix: 'r4-orphan',
        }),
      ).rejects.toThrow('simulated AgentSession constructor failure');

      // Post-condition [R4]: the child id that was registered in the AbortGraph
      // before construction was attempted must have been disposed — no orphan
      // node survives a failed fork.
      //
      // registered contains: rootId (from SubagentManager ctor) + childId (from forkSubagent).
      // disposed must contain the childId (not the rootId, which is still live).
      const childIds = registered.filter((id) => id.startsWith('r4-orphan'));
      expect(childIds).toHaveLength(1);
      const childId = childIds[0]!;
      expect(disposed).toContain(childId);

      // Manager's active map must also be empty — no stale handle.
      expect(mgr.list()).toHaveLength(0);

      // Post-condition [R4 — link cleanup]: dispose must also remove the
      // parent→child edge, not just the child node. Without this guard, a
      // ghost link persists and a later abort on the root would try to
      // cascade to a non-existent child.
      expect(capturedGraph).toBeDefined();
      const rootIds = registered.filter((id) => !id.startsWith('r4-orphan'));
      expect(rootIds).toHaveLength(1);
      const rootId = rootIds[0]!;
      expect(capturedGraph!.childrenOf(rootId)).not.toContain(childId);

      vi.restoreAllMocks();
    });

    it('forkSubagent does NOT dispose a node on successful construction', async () => {
      // Regression guard: the try/catch must not call dispose on the happy path.
      const { AbortGraph: AG } = await import('./abort-graph.js');
      const disposed: string[] = [];
      const origDispose = AG.prototype.dispose;

      vi.spyOn(AG.prototype, 'dispose').mockImplementation(function (
        this: InstanceType<typeof AG>,
        id: string,
      ) {
        disposed.push(id);
        return origDispose.call(this, id);
      });

      const mgr = new SubagentManager();
      const handle = await mgr.forkSubagent({
        parent: { sessionId: 'p' },
        config: { model: 'sonnet' },
        idPrefix: 'r4-success',
      });

      // On success, the child node must still be live (dispose not called yet).
      expect(disposed.some((id) => id === handle.id)).toBe(false);

      // Cleanup: kill removes it, dispose fires then.
      await mgr.kill(handle.id);
      expect(disposed.some((id) => id === handle.id)).toBe(true);

      vi.restoreAllMocks();
    });
  });
});
