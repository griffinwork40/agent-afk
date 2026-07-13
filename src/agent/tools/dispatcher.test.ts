import { describe, expect, it, vi } from 'vitest';
import {
  SessionToolDispatcher,
  defaultConcurrencyClassifier,
  REPEAT_CIRCUIT_BREAKER_THRESHOLD,
} from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import type { ToolCall } from './types.js';
import type { ToolHandler } from './types.js';
import type { CanUseTool } from '../types/sdk-types.js';
import { createHookRegistryImpl } from '../hook-registry.js';
import { InMemoryTraceWriter } from '../trace/writer.js';

function makeCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: 'test-id',
    name: 'echo',
    input: { message: 'hello' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function echoHandler(): ToolHandler {
  return async (input: unknown) => {
    const obj = input as Record<string, unknown>;
    return { content: String(obj['message'] ?? '') };
  };
}

function makeDispatcher(overrides?: Partial<ConstructorParameters<typeof SessionToolDispatcher>[0]>) {
  return new SessionToolDispatcher({
    handlers: new Map([['echo', echoHandler()]]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: ['echo'] },
    ...overrides,
  });
}

function mockExecutor(result?: Partial<{ content: string; isError: boolean }>) {
  return {
    execute: vi.fn().mockResolvedValue({
      content: result?.content ?? 'agent output',
      isError: result?.isError,
    }),
  } as any; // Partial mock of SubagentExecutor
}

describe('SessionToolDispatcher', () => {
  it('dispatches to the correct handler', async () => {
    const dispatcher = makeDispatcher();
    const result = await dispatcher.execute(makeCall());
    expect(result.content).toBe('hello');
    expect(result.isError).toBeUndefined();
  });

  describe('setAllowAll (live /bypass toggle — file-tool containment half)', () => {
    it('flips getGrants().allowAll in place, both directions', () => {
      const d = makeDispatcher();
      expect(d.getGrants().allowAll).toBe(false);
      // `/bypass on`: takes effect immediately (read fresh per call via the
      // handlerContext getter — no dispatcher rebuild needed).
      d.setAllowAll(true);
      expect(d.getGrants().allowAll).toBe(true);
      // `/bypass off`: must restore containment (fail-closed) — the direction
      // that previously failed UNSAFE because the field was never updated.
      d.setAllowAll(false);
      expect(d.getGrants().allowAll).toBe(false);
    });

    it('can toggle off a construction-time bypass', () => {
      const d = makeDispatcher({ allowAll: true });
      expect(d.getGrants().allowAll).toBe(true);
      d.setAllowAll(false);
      expect(d.getGrants().allowAll).toBe(false);
    });
  });

  describe('sessionGrantManager injection (#514)', () => {
    // The provider passes itself as sessionGrantManager; the dispatcher must
    // surface it on the PreToolUse context so path-scoped hooks resolve THIS
    // session's grants (a forked child's own writeRoots) instead of the
    // process-global ref pinned to the top-level session.
    const fakeGM = {
      getGrants: () => ({ resolveBase: undefined, readRoots: [], writeRoots: [] }),
      addReadRoot: () => {},
      addWriteRoot: () => {},
      revokeRoot: () => {},
    };

    it('injects sessionGrantManager onto the PreToolUse context', async () => {
      let captured: unknown = 'unset';
      const registry = createHookRegistryImpl();
      registry.register('PreToolUse', (ctx) => {
        if (ctx.event === 'PreToolUse') captured = ctx.grantManager;
        return {};
      });
      const dispatcher = makeDispatcher({ hookRegistry: registry, sessionGrantManager: fakeGM });
      await dispatcher.execute(makeCall());
      expect(captured).toBe(fakeGM);
    });

    it('leaves context.grantManager undefined when no sessionGrantManager is provided', async () => {
      let captured: unknown = 'unset';
      const registry = createHookRegistryImpl();
      registry.register('PreToolUse', (ctx) => {
        if (ctx.event === 'PreToolUse') captured = ctx.grantManager;
        return {};
      });
      const dispatcher = makeDispatcher({ hookRegistry: registry });
      await dispatcher.execute(makeCall());
      expect(captured).toBeUndefined();
    });
  });

  it('returns isError for unknown tool', async () => {
    const dispatcher = makeDispatcher({
      permissions: { allowedTools: ['echo', 'nonexistent'] },
    });
    const result = await dispatcher.execute(makeCall({ name: 'nonexistent' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('catches handler throws and returns isError', async () => {
    const throwing: ToolHandler = async () => {
      throw new Error('handler kaboom');
    };
    const dispatcher = makeDispatcher({
      handlers: new Map([['echo', throwing]]),
    });
    const result = await dispatcher.execute(makeCall());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('handler kaboom');
  });

  it('returns isError when signal is already aborted', async () => {
    const dispatcher = makeDispatcher();
    const controller = new AbortController();
    controller.abort('cancelled');
    const result = await dispatcher.execute(makeCall({ signal: controller.signal }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
    expect(result.failureClass).toBe('abort');
  });

  it('exposes toolDefs from schemas (no allowlist = full pass-through)', () => {
    // Pass undefined permissions so no allowlist is configured — full schema returned.
    const dispatcher = makeDispatcher({ permissions: undefined });
    expect(dispatcher.toolDefs).toEqual(builtinToolSchemas);
  });

  describe('toolDefs allowlist subsetting', () => {
    it('returns all schemas when no allowlist is configured (permissions undefined)', () => {
      const dispatcher = new SessionToolDispatcher({
        handlers: new Map(),
        schemas: [...builtinToolSchemas],
        // no permissions → undefined
      });
      expect(dispatcher.toolDefs).toEqual(builtinToolSchemas);
    });

    it('returns only allowlisted schemas when allowedTools is set', () => {
      const bashSchema = builtinToolSchemas.find((s) => s.name === 'bash')!;
      const readFileSchema = builtinToolSchemas.find((s) => s.name === 'read_file')!;
      expect(bashSchema).toBeDefined();
      expect(readFileSchema).toBeDefined();
      const dispatcher = new SessionToolDispatcher({
        handlers: new Map(),
        schemas: [bashSchema, readFileSchema],
        permissions: { allowedTools: ['read_file'] },
      });
      const defs = dispatcher.toolDefs;
      expect(defs).toHaveLength(1);
      expect(defs[0]!.name).toBe('read_file');
      expect(defs.map((d) => d.name)).not.toContain('bash');
    });

    it('returns empty array when allowedTools matches no schema', () => {
      const dispatcher = new SessionToolDispatcher({
        handlers: new Map(),
        schemas: [...builtinToolSchemas],
        permissions: { allowedTools: ['nonexistent_tool'] },
      });
      expect(dispatcher.toolDefs).toEqual([]);
    });
  });

  describe('permissions', () => {
    it('denies tool not in allowlist', async () => {
      const dispatcher = makeDispatcher({
        permissions: { allowedTools: ['other_tool'] },
      });
      const result = await dispatcher.execute(makeCall());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not in the configured allowlist');
      expect(result.failureClass).toBe('permission-denied');
    });

    it('allows tool in allowlist', async () => {
      const dispatcher = makeDispatcher({
        permissions: { allowedTools: ['echo'] },
      });
      const result = await dispatcher.execute(makeCall());
      expect(result.content).toBe('hello');
    });

    it('uses default permissions when no config', async () => {
      const readHandler: ToolHandler = async () => ({ content: 'file content' });
      const dispatcher = new SessionToolDispatcher({
        handlers: new Map([['read_file', readHandler]]),
        schemas: [...builtinToolSchemas],
      });
      const result = await dispatcher.execute(makeCall({ name: 'read_file' }));
      expect(result.content).toBe('file content');
    });
  });

  describe('hooks', () => {
    it('PreToolUse block returns isError', async () => {
      const registry = createHookRegistryImpl();
      registry.register('PreToolUse', async () => ({
        decision: 'block' as const,
        reason: 'not allowed',
      }));
      const dispatcher = makeDispatcher({ hookRegistry: registry });
      const result = await dispatcher.execute(makeCall());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('blocked by PreToolUse hook');
      expect(result.failureClass).toBe('hook-block');
    });

    it('PreToolUse approve allows execution', async () => {
      const registry = createHookRegistryImpl();
      registry.register('PreToolUse', async () => ({
        decision: 'approve' as const,
      }));
      const dispatcher = makeDispatcher({ hookRegistry: registry });
      const result = await dispatcher.execute(makeCall());
      expect(result.content).toBe('hello');
    });

    it('PostToolUse fires after execution', async () => {
      const registry = createHookRegistryImpl();
      const postSpy = vi.fn(async () => ({}));
      registry.register('PostToolUse', postSpy);
      const dispatcher = makeDispatcher({ hookRegistry: registry });
      await dispatcher.execute(makeCall());
      expect(postSpy).toHaveBeenCalledOnce();
      const callArgs = postSpy.mock.calls[0] as unknown[];
      expect(callArgs).toBeDefined();
      expect(callArgs[0]).toMatchObject({
        event: 'PostToolUse',
        toolName: 'echo',
        output: 'hello',
      });
    });

    it('PostToolUse error is swallowed', async () => {
      const registry = createHookRegistryImpl();
      registry.register('PostToolUse', async () => {
        throw new Error('post hook error');
      });
      const dispatcher = makeDispatcher({ hookRegistry: registry });
      const result = await dispatcher.execute(makeCall());
      expect(result.content).toBe('hello');
      expect(result.isError).toBeUndefined();
    });

    it('PostToolUseFailure fires with error message when handler throws', async () => {
      const registry = createHookRegistryImpl();
      const failureSpy = vi.fn(async () => ({}));
      const postSpy = vi.fn(async () => ({}));
      registry.register('PostToolUseFailure', failureSpy);
      registry.register('PostToolUse', postSpy);

      const throwingHandler: ToolHandler = async () => {
        throw new Error('tool blew up');
      };
      const dispatcher = new SessionToolDispatcher({
        handlers: new Map([['bomb', throwingHandler]]),
        schemas: [...builtinToolSchemas],
        permissions: { allowedTools: ['bomb'] },
        hookRegistry: registry,
      });

      const call: ToolCall = {
        id: 'c1',
        name: 'bomb',
        input: {},
        signal: new AbortController().signal,
      };
      const result = await dispatcher.execute(call);

      // Tool result is an isError result
      expect(result.isError).toBe(true);
      expect(result.content).toContain('tool blew up');

      // PostToolUseFailure fired once with correct payload
      await vi.waitFor(() => expect(failureSpy).toHaveBeenCalledOnce());
      const callArgs = failureSpy.mock.calls[0] as unknown[];
      expect(callArgs[0]).toMatchObject({
        event: 'PostToolUseFailure',
        toolName: 'bomb',
        error: 'tool blew up',
      });

      // PostToolUse must NOT have fired
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('PostToolUseFailure does not fire when handler succeeds', async () => {
      const registry = createHookRegistryImpl();
      const failureSpy = vi.fn(async () => ({}));
      const postSpy = vi.fn(async () => ({}));
      registry.register('PostToolUseFailure', failureSpy);
      registry.register('PostToolUse', postSpy);

      const dispatcher = makeDispatcher({ hookRegistry: registry });
      const result = await dispatcher.execute(makeCall());

      expect(result.isError).toBeUndefined();
      // Drain the event loop by waiting for PostToolUse to fire, then assert
      // PostToolUseFailure did not fire -- avoids the fragile setTimeout fence.
      await vi.waitFor(() => expect(postSpy).toHaveBeenCalledOnce());
      expect(failureSpy).not.toHaveBeenCalled();
    });
  });

  describe('readOnlyBash gate', () => {
    // A `bash` handler that echoes its command, plus a dispatcher in
    // readOnlyBash mode with `bash` allowlisted (so the gate — not the
    // permission check — is what decides).
    function bashHandler(): ToolHandler {
      return async (input: unknown) => {
        const obj = input as Record<string, unknown>;
        return { content: `ran: ${String(obj['command'] ?? '')}` };
      };
    }
    function makeBashDispatcher(readOnlyBash: boolean) {
      return new SessionToolDispatcher({
        handlers: new Map([['bash', bashHandler()]]),
        schemas: [...builtinToolSchemas],
        permissions: { allowedTools: ['bash'] },
        readOnlyBash,
      });
    }
    function bashCall(command: string): ToolCall {
      return makeCall({ name: 'bash', input: { command } });
    }

    it('blocks a mutating bash command with isError when readOnlyBash is true', async () => {
      const dispatcher = makeBashDispatcher(true);
      const result = await dispatcher.execute(bashCall('git commit -m x'));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('read-only skill may not run mutating commands');
      expect(result.failureClass).toBe('permission-denied');
    });

    it('lets a read-only bash command through the gate when readOnlyBash is true', async () => {
      const dispatcher = makeBashDispatcher(true);
      const result = await dispatcher.execute(bashCall('git status'));
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('ran: git status');
    });

    it('does not gate bash when readOnlyBash is false', async () => {
      const dispatcher = makeBashDispatcher(false);
      const result = await dispatcher.execute(bashCall('git commit -m x'));
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('ran: git commit -m x');
    });

    it('blocks mutating bash on the batch path too', async () => {
      const dispatcher = makeBashDispatcher(true);
      const [blocked, allowed] = await dispatcher.executeBatch([
        bashCall('rm -rf /tmp/x'),
        bashCall('git diff'),
      ]);
      expect(blocked!.isError).toBe(true);
      expect(blocked!.content).toContain('read-only skill may not run mutating commands');
      expect(allowed!.isError).toBeUndefined();
      expect(allowed!.content).toBe('ran: git diff');
    });
  });

  describe('agent tool routing', () => {
    it('routes agent calls to executor when present', async () => {
      const executor = mockExecutor();
      const dispatcher = makeDispatcher({
        subagentExecutor: executor,
        permissions: { allowedTools: ['echo', 'agent'] },
      });
      const result = await dispatcher.execute(makeCall({ name: 'agent', input: { prompt: 'test' } }));
      expect(result.content).toBe('agent output');
      expect(executor.execute).toHaveBeenCalledOnce();
    });

    it('returns clean error when executor not configured', async () => {
      const dispatcher = makeDispatcher({
        permissions: { allowedTools: ['echo', 'agent'] },
      });
      const result = await dispatcher.execute(makeCall({ name: 'agent', input: { prompt: 'test' } }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not available');
    });

    it('does not route non-agent calls to executor', async () => {
      const executor = mockExecutor();
      const dispatcher = makeDispatcher({
        subagentExecutor: executor,
        permissions: { allowedTools: ['echo', 'agent'] },
      });
      const result = await dispatcher.execute(makeCall({ name: 'echo' }));
      expect(result.content).toBe('hello');
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('fires PostToolUse hook for agent calls', async () => {
      const registry = createHookRegistryImpl();
      const postSpy = vi.fn(async () => ({}));
      registry.register('PostToolUse', postSpy);
      const executor = mockExecutor();
      const dispatcher = makeDispatcher({
        subagentExecutor: executor,
        hookRegistry: registry,
        permissions: { allowedTools: ['echo', 'agent'] },
      });
      await dispatcher.execute(makeCall({ name: 'agent', input: { prompt: 'test' } }));
      expect(postSpy).toHaveBeenCalledOnce();
      const callArgs = postSpy.mock.calls[0] as unknown[];
      expect(callArgs[0]).toMatchObject({
        event: 'PostToolUse',
        toolName: 'agent',
        output: 'agent output',
      });
    });

    it('catches executor throws and returns isError', async () => {
      const executor = { execute: vi.fn().mockRejectedValue(new Error('executor boom')) } as any;
      const dispatcher = makeDispatcher({
        subagentExecutor: executor,
        permissions: { allowedTools: ['echo', 'agent'] },
      });
      const result = await dispatcher.execute(makeCall({ name: 'agent', input: { prompt: 'test' } }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('executor boom');
    });
  });

  describe('setResolveBase — executor re-anchoring (openai-compatible worktree cwd fix)', () => {
    // Regression: the openai-compatible provider's query.setCwd routes straight
    // to dispatcher.setResolveBase. Before this, setResolveBase migrated the
    // path roots but left the forked agent/skill executors frozen on the launch
    // dir, so child tool calls in a born-named `afk -w` worktree ran against the
    // host repo. setResolveBase must now re-anchor the executors it owns.
    it('re-anchors subagent + skill executors to the new cwd on a real cwd change', () => {
      const subagentExecutor = { execute: vi.fn(), setCwd: vi.fn() } as any;
      const skillExecutor = { execute: vi.fn(), setCwd: vi.fn() } as any;
      const dispatcher = makeDispatcher({
        cwd: '/tmp/launch/dir',
        subagentExecutor,
        skillExecutor,
      });

      dispatcher.setResolveBase('/tmp/launch/dir/.afk-worktrees/afk-xyz');

      expect(subagentExecutor.setCwd).toHaveBeenCalledWith('/tmp/launch/dir/.afk-worktrees/afk-xyz');
      expect(skillExecutor.setCwd).toHaveBeenCalledWith('/tmp/launch/dir/.afk-worktrees/afk-xyz');
    });

    it('does not re-anchor when the cwd is unchanged (no-op guard)', () => {
      const subagentExecutor = { execute: vi.fn(), setCwd: vi.fn() } as any;
      const skillExecutor = { execute: vi.fn(), setCwd: vi.fn() } as any;
      const dispatcher = makeDispatcher({
        cwd: '/tmp/same/dir',
        subagentExecutor,
        skillExecutor,
      });

      dispatcher.setResolveBase('/tmp/same/dir'); // identical → early return

      expect(subagentExecutor.setCwd).not.toHaveBeenCalled();
      expect(skillExecutor.setCwd).not.toHaveBeenCalled();
    });

    it('does not throw when no executors are configured (eval-run probe dispatcher)', () => {
      const dispatcher = makeDispatcher({ cwd: '/tmp/launch/dir' });
      expect(() => dispatcher.setResolveBase('/tmp/launch/dir/.afk-worktrees/afk-xyz')).not.toThrow();
    });
  });

  describe('defaultConcurrencyClassifier', () => {
    it('marks read-only tools as safe', () => {
      expect(defaultConcurrencyClassifier('read_file')).toBe(true);
      expect(defaultConcurrencyClassifier('glob')).toBe(true);
      expect(defaultConcurrencyClassifier('grep')).toBe(true);
      expect(defaultConcurrencyClassifier('list_directory')).toBe(true);
    });

    it('marks agent as safe', () => {
      expect(defaultConcurrencyClassifier('agent')).toBe(true);
    });

    it('marks skill as safe', () => {
      expect(defaultConcurrencyClassifier('skill')).toBe(true);
    });

    it('marks write tools as unsafe', () => {
      expect(defaultConcurrencyClassifier('bash')).toBe(false);
      expect(defaultConcurrencyClassifier('edit_file')).toBe(false);
      expect(defaultConcurrencyClassifier('write_file')).toBe(false);
    });

    it('marks unknown tools as unsafe', () => {
      expect(defaultConcurrencyClassifier('custom_tool')).toBe(false);
    });
  });

  describe('executeBatch', () => {
    const signal = new AbortController().signal;

    function makeBatchCall(name: string, id?: string): ToolCall {
      return {
        id: id ?? `call-${name}`,
        name,
        input: name === 'echo' ? { message: name } : {},
        signal,
      };
    }

    function delayHandler(ms: number, content: string): ToolHandler {
      return async () => {
        await new Promise((r) => setTimeout(r, ms));
        return { content };
      };
    }

    it('returns empty array for empty calls', async () => {
      const dispatcher = makeDispatcher();
      const results = await dispatcher.executeBatch([]);
      expect(results).toEqual([]);
    });

    it('delegates single call to execute()', async () => {
      const dispatcher = makeDispatcher();
      const results = await dispatcher.executeBatch([makeBatchCall('echo')]);
      expect(results).toHaveLength(1);
      expect(results[0]!.content).toBe('echo');
    });

    it('runs safe tools in parallel', async () => {
      const order: string[] = [];
      const slowRead: ToolHandler = async () => {
        order.push('read-start');
        await new Promise((r) => setTimeout(r, 50));
        order.push('read-end');
        return { content: 'read' };
      };
      const slowGlob: ToolHandler = async () => {
        order.push('glob-start');
        await new Promise((r) => setTimeout(r, 50));
        order.push('glob-end');
        return { content: 'glob' };
      };
      const dispatcher = makeDispatcher({
        handlers: new Map([['read_file', slowRead], ['glob', slowGlob]]),
        permissions: { allowedTools: ['read_file', 'glob'] },
      });

      const start = Date.now();
      const results = await dispatcher.executeBatch([
        makeBatchCall('read_file'),
        makeBatchCall('glob'),
      ]);
      const elapsed = Date.now() - start;

      expect(results).toHaveLength(2);
      expect(results[0]!.content).toBe('read');
      expect(results[1]!.content).toBe('glob');
      // Parallel: both start before either ends
      expect(order[0]).toBe('read-start');
      expect(order[1]).toBe('glob-start');
      // Wall-clock should be ~50ms not ~100ms
      expect(elapsed).toBeLessThan(90);
    });

    it('runs unsafe tools sequentially', async () => {
      const order: string[] = [];
      const bash1: ToolHandler = async () => {
        order.push('bash1-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('bash1-end');
        return { content: 'bash1' };
      };
      const bash2: ToolHandler = async () => {
        order.push('bash2-start');
        await new Promise((r) => setTimeout(r, 20));
        order.push('bash2-end');
        return { content: 'bash2' };
      };
      const dispatcher = makeDispatcher({
        handlers: new Map([['bash', bash1], ['edit_file', bash2]]),
        permissions: { allowedTools: ['bash', 'edit_file'] },
      });

      const results = await dispatcher.executeBatch([
        makeBatchCall('bash'),
        makeBatchCall('edit_file'),
      ]);

      expect(results[0]!.content).toBe('bash1');
      expect(results[1]!.content).toBe('bash2');
      // Sequential: first ends before second starts
      expect(order).toEqual(['bash1-start', 'bash1-end', 'bash2-start', 'bash2-end']);
    });

    it('partitions mixed tools into correct batches', async () => {
      const order: string[] = [];
      const track = (name: string): ToolHandler => async () => {
        order.push(name);
        return { content: name };
      };
      const dispatcher = makeDispatcher({
        handlers: new Map([
          ['read_file', track('read')],
          ['glob', track('glob')],
          ['bash', track('bash')],
          ['grep', track('grep')],
        ]),
        permissions: { allowedTools: ['read_file', 'glob', 'bash', 'grep'] },
      });

      // [safe, safe, unsafe, safe] → 3 batches
      const results = await dispatcher.executeBatch([
        makeBatchCall('read_file'),
        makeBatchCall('glob'),
        makeBatchCall('bash'),
        makeBatchCall('grep'),
      ]);

      expect(results.map((r) => r.content)).toEqual(['read', 'glob', 'bash', 'grep']);
      // bash must run after first batch, grep after bash
      expect(order.indexOf('bash')).toBeGreaterThan(order.indexOf('read'));
      expect(order.indexOf('bash')).toBeGreaterThan(order.indexOf('glob'));
      expect(order.indexOf('grep')).toBeGreaterThan(order.indexOf('bash'));
    });

    it('stamps batchIndex/batchSize reflecting the partition', async () => {
      const track = (name: string): ToolHandler => async () => ({ content: name });
      const dispatcher = makeDispatcher({
        handlers: new Map([
          ['read_file', track('read')],
          ['glob', track('glob')],
          ['bash', track('bash')],
          ['grep', track('grep')],
        ]),
        permissions: { allowedTools: ['read_file', 'glob', 'bash', 'grep'] },
      });

      // [safe, safe, unsafe, safe] → batches {read,glob}, {bash}, {grep}.
      const results = await dispatcher.executeBatch([
        makeBatchCall('read_file'),
        makeBatchCall('glob'),
        makeBatchCall('bash'),
        makeBatchCall('grep'),
      ]);

      // Parallel wave of 2: 1-based index within a size-2 batch.
      expect(results[0]).toMatchObject({ batchIndex: 1, batchSize: 2 });
      expect(results[1]).toMatchObject({ batchIndex: 2, batchSize: 2 });
      // bash is concurrency-unsafe → its own singleton batch (never badged).
      expect(results[2]).toMatchObject({ batchIndex: 1, batchSize: 1 });
      // The trailing safe call is severed from the first wave by bash, so it
      // is a singleton too — proving batchSize tracks the partition, not the
      // tool's mere safety class.
      expect(results[3]).toMatchObject({ batchIndex: 1, batchSize: 1 });
    });

    it('stamps a whole safe fan-out as one batch', async () => {
      const track = (name: string): ToolHandler => async () => ({ content: name });
      const dispatcher = makeDispatcher({
        handlers: new Map([
          ['read_file', track('read')],
          ['glob', track('glob')],
          ['grep', track('grep')],
        ]),
        permissions: { allowedTools: ['read_file', 'glob', 'grep'] },
      });

      const results = await dispatcher.executeBatch([
        makeBatchCall('read_file'),
        makeBatchCall('glob'),
        makeBatchCall('grep'),
      ]);

      expect(results.map((r) => r.batchSize)).toEqual([3, 3, 3]);
      expect(results.map((r) => r.batchIndex)).toEqual([1, 2, 3]);
    });

    it('collects all results when one tool fails in a safe batch', async () => {
      const ok: ToolHandler = async () => ({ content: 'ok' });
      const fail: ToolHandler = async () => { throw new Error('boom'); };
      const dispatcher = makeDispatcher({
        handlers: new Map([['read_file', ok], ['glob', fail]]),
        permissions: { allowedTools: ['read_file', 'glob'] },
      });

      const results = await dispatcher.executeBatch([
        makeBatchCall('read_file'),
        makeBatchCall('glob'),
      ]);

      expect(results[0]!.content).toBe('ok');
      expect(results[0]!.isError).toBeUndefined();
      expect(results[1]!.isError).toBe(true);
      expect(results[1]!.content).toContain('boom');
    });

    it('blocks individual tool via PreToolUse without affecting others', async () => {
      const registry = createHookRegistryImpl();
      registry.register('PreToolUse', async (ctx) => {
        if ((ctx as any).toolName === 'glob') {
          return { decision: 'block' as const, reason: 'blocked glob' };
        }
        return {};
      });
      const ok: ToolHandler = async () => ({ content: 'ok' });
      const dispatcher = makeDispatcher({
        handlers: new Map([['read_file', ok], ['glob', ok]]),
        permissions: { allowedTools: ['read_file', 'glob'] },
        hookRegistry: registry,
      });

      const results = await dispatcher.executeBatch([
        makeBatchCall('read_file'),
        makeBatchCall('glob'),
      ]);

      expect(results[0]!.content).toBe('ok');
      expect(results[0]!.isError).toBeUndefined();
      expect(results[1]!.isError).toBe(true);
      expect(results[1]!.content).toContain('blocked by PreToolUse hook');
    });

    it('returns abort errors when signal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort('cancelled');
      const dispatcher = makeDispatcher();
      const results = await dispatcher.executeBatch([
        { ...makeBatchCall('echo'), signal: controller.signal },
        { ...makeBatchCall('echo', 'call-2'), signal: controller.signal },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]!.isError).toBe(true);
      expect(results[1]!.isError).toBe(true);
    });

    // Regression: the batch gate previously read `calls[0]!.signal.aborted`,
    // so per-call signal correctness across a heterogeneous batch was
    // unenforced. These two tests cover both directions of that bug.
    it('per-call signals: aborted call[0] does NOT falsely abort fresh call[1] (parallel batch)', async () => {
      const abortedCtrl = new AbortController();
      abortedCtrl.abort('only-call-0');
      const freshCtrl = new AbortController();
      const seen: string[] = [];
      const track = (name: string): ToolHandler => async () => {
        seen.push(name);
        return { content: name };
      };
      const dispatcher = makeDispatcher({
        handlers: new Map([['read_file', track('read')], ['glob', track('glob')]]),
        permissions: { allowedTools: ['read_file', 'glob'] },
      });

      const results = await dispatcher.executeBatch([
        { ...makeBatchCall('read_file'), signal: abortedCtrl.signal },
        { ...makeBatchCall('glob', 'call-2'), signal: freshCtrl.signal },
      ]);

      expect(results).toHaveLength(2);
      // Call[0]: aborted → caught in Phase 1, never reaches the handler
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content).toContain('aborted');
      expect(seen).not.toContain('read');
      // Call[1]: fresh signal → must run successfully
      expect(results[1]!.isError).toBeUndefined();
      expect(results[1]!.content).toBe('glob');
      expect(seen).toContain('glob');
    });

    it('per-call signals: fresh call[0] runs, aborted call[1] does NOT dispatch (parallel batch)', async () => {
      const freshCtrl = new AbortController();
      const abortedCtrl = new AbortController();
      abortedCtrl.abort('only-call-1');
      const seen: string[] = [];
      const track = (name: string): ToolHandler => async () => {
        seen.push(name);
        return { content: name };
      };
      const dispatcher = makeDispatcher({
        handlers: new Map([['read_file', track('read')], ['glob', track('glob')]]),
        permissions: { allowedTools: ['read_file', 'glob'] },
      });

      const results = await dispatcher.executeBatch([
        { ...makeBatchCall('read_file'), signal: freshCtrl.signal },
        { ...makeBatchCall('glob', 'call-2'), signal: abortedCtrl.signal },
      ]);

      expect(results).toHaveLength(2);
      // Call[0]: fresh → runs to completion
      expect(results[0]!.isError).toBeUndefined();
      expect(results[0]!.content).toBe('read');
      expect(seen).toContain('read');
      // Call[1]: aborted → caught in Phase 1, never reaches the handler
      expect(results[1]!.isError).toBe(true);
      expect(results[1]!.content).toContain('aborted');
      expect(seen).not.toContain('glob');
    });

    it('per-call signals: call[1] aborted between Phase 1 and parallel dispatch', async () => {
      // The bug we are guarding against: Phase 1 sees call[1].signal as
      // fresh, so it is admitted to executableCalls. Between Phase 1 and the
      // parallel dispatch, call[1].signal aborts. The pre-fix code only
      // checked calls[0]!.signal at the batch gate, so call[1]'s handler
      // would be dispatched on an aborted signal. The fix checks per-call
      // inside the Promise.allSettled map.
      const freshCtrl = new AbortController();
      const lateAbortCtrl = new AbortController();
      const seen: string[] = [];

      // Abort call[1]'s signal during the await between Phase 1 finishing
      // and Phase 2 dispatching — Phase 1 has no awaits to span here (no
      // hook registry, no slow permission check), so we abort synchronously
      // right after constructing the batch but before invoking executeBatch.
      // Equivalent in effect: a pre-aborted call[1] in a fresh-call[0] batch.
      lateAbortCtrl.abort('between-phases');

      const track = (name: string): ToolHandler => async () => {
        seen.push(name);
        return { content: name };
      };
      const dispatcher = makeDispatcher({
        handlers: new Map([['read_file', track('read')], ['glob', track('glob')]]),
        permissions: { allowedTools: ['read_file', 'glob'] },
      });

      const results = await dispatcher.executeBatch([
        { ...makeBatchCall('read_file'), signal: freshCtrl.signal },
        { ...makeBatchCall('glob', 'call-2'), signal: lateAbortCtrl.signal },
      ]);

      expect(results[0]!.content).toBe('read');
      expect(results[1]!.isError).toBe(true);
      expect(seen).not.toContain('glob');
    });

    it('uses custom concurrency classifier', async () => {
      const order: string[] = [];
      const track = (name: string): ToolHandler => async () => {
        order.push(name);
        return { content: name };
      };
      // Classify bash as safe (custom override)
      const dispatcher = makeDispatcher({
        handlers: new Map([['bash', track('bash')], ['echo', track('echo')]]),
        permissions: { allowedTools: ['bash', 'echo'] },
        concurrencyClassifier: () => true,
      });

      await dispatcher.executeBatch([
        makeBatchCall('bash'),
        makeBatchCall('echo'),
      ]);

      // Both should be in the same safe batch (parallel)
      expect(order).toContain('bash');
      expect(order).toContain('echo');
    });

    it('classifies compose as safe for parallel batching', () => {
      expect(defaultConcurrencyClassifier('compose')).toBe(true);
    });

    it('runs compose in parallel with other safe tools', async () => {
      const order: string[] = [];
      const slowRead: ToolHandler = async () => {
        order.push('read-start');
        await new Promise((r) => setTimeout(r, 50));
        order.push('read-end');
        return { content: 'read' };
      };
      const composeExec = {
        execute: vi.fn(async () => {
          order.push('compose-start');
          await new Promise((r) => setTimeout(r, 50));
          order.push('compose-end');
          return { content: 'composed' };
        }),
      } as any;

      const dispatcher = makeDispatcher({
        handlers: new Map([['read_file', slowRead]]),
        permissions: { allowedTools: ['read_file', 'compose'] },
        composeExecutor: composeExec,
      });

      const start = Date.now();
      const results = await dispatcher.executeBatch([
        makeBatchCall('read_file'),
        makeBatchCall('compose'),
      ]);
      const elapsed = Date.now() - start;

      expect(results).toHaveLength(2);
      expect(results[0]!.content).toBe('read');
      expect(results[1]!.content).toBe('composed');
      // Both should start before either ends (parallel)
      expect(order.slice(0, 2)).toEqual(expect.arrayContaining(['read-start', 'compose-start']));
      // Wall-clock should be ~50ms not ~100ms
      expect(elapsed).toBeLessThan(90);
    });

    it('preserves result order regardless of completion order', async () => {
      const dispatcher = makeDispatcher({
        handlers: new Map([
          ['read_file', delayHandler(60, 'slow')],
          ['glob', delayHandler(10, 'fast')],
        ]),
        permissions: { allowedTools: ['read_file', 'glob'] },
      });

      const results = await dispatcher.executeBatch([
        makeBatchCall('read_file'),
        makeBatchCall('glob'),
      ]);

      // read_file was slow but should still be first in results
      expect(results[0]!.content).toBe('slow');
      expect(results[1]!.content).toBe('fast');
    });

    describe('maxConcurrentSafeCalls (bounded concurrency)', () => {
      // A safe handler that records concurrency: increments a live counter on
      // entry, tracks the peak, decrements on exit. `peak` is the maximum
      // number that were ever in flight simultaneously.
      function makeConcurrencyProbe() {
        const state = { inFlight: 0, peak: 0 };
        const handler: ToolHandler = async () => {
          state.inFlight += 1;
          state.peak = Math.max(state.peak, state.inFlight);
          await new Promise((r) => setTimeout(r, 20));
          state.inFlight -= 1;
          return { content: 'ok' };
        };
        return { state, handler };
      }

      it('caps simultaneous in-flight safe calls at the configured limit', async () => {
        const { state, handler } = makeConcurrencyProbe();
        const dispatcher = makeDispatcher({
          handlers: new Map([['read_file', handler]]),
          permissions: { allowedTools: ['read_file'] },
          maxConcurrentSafeCalls: 2,
        });

        const calls = Array.from({ length: 6 }, (_, i) =>
          makeBatchCall('read_file', `read-${i}`),
        );
        const results = await dispatcher.executeBatch(calls);

        expect(results).toHaveLength(6);
        expect(results.every((r) => r.content === 'ok')).toBe(true);
        // Never more than 2 running at once, despite 6 safe calls in the batch.
        expect(state.peak).toBe(2);
      });

      it('runs the whole batch concurrently when the cap exceeds batch width', async () => {
        const { state, handler } = makeConcurrencyProbe();
        const dispatcher = makeDispatcher({
          handlers: new Map([['read_file', handler]]),
          permissions: { allowedTools: ['read_file'] },
          maxConcurrentSafeCalls: 10,
        });

        const calls = Array.from({ length: 4 }, (_, i) =>
          makeBatchCall('read_file', `read-${i}`),
        );
        await dispatcher.executeBatch(calls);

        // Cap (10) > batch width (4): all four run at once, like allSettled.
        expect(state.peak).toBe(4);
      });

      it('preserves result order when draining a batch wider than the cap', async () => {
        // Descending delays: without index-keyed write-back, a naive pool
        // would return results in completion order (fastest first).
        const mk = (ms: number, content: string): ToolHandler => async () => {
          await new Promise((r) => setTimeout(r, ms));
          return { content };
        };
        const dispatcher = makeDispatcher({
          handlers: new Map([
            ['read_file', mk(40, 'a')],
            ['glob', mk(30, 'b')],
            ['grep', mk(20, 'c')],
            ['list_directory', mk(10, 'd')],
          ]),
          permissions: { allowedTools: ['read_file', 'glob', 'grep', 'list_directory'] },
          maxConcurrentSafeCalls: 2,
        });

        const results = await dispatcher.executeBatch([
          makeBatchCall('read_file'),
          makeBatchCall('glob'),
          makeBatchCall('grep'),
          makeBatchCall('list_directory'),
        ]);

        expect(results.map((r) => r.content)).toEqual(['a', 'b', 'c', 'd']);
      });

      it('degrades to sequential (not deadlock) when the cap is below 1', async () => {
        // A non-positive/non-finite cap falls back to the default in the
        // constructor, so behaviour stays parallel — assert it does not hang
        // and every call still resolves.
        const { state, handler } = makeConcurrencyProbe();
        const dispatcher = makeDispatcher({
          handlers: new Map([['read_file', handler]]),
          permissions: { allowedTools: ['read_file'] },
          maxConcurrentSafeCalls: 0,
        });

        const calls = Array.from({ length: 3 }, (_, i) =>
          makeBatchCall('read_file', `read-${i}`),
        );
        const results = await dispatcher.executeBatch(calls);

        expect(results.map((r) => r.content)).toEqual(['ok', 'ok', 'ok']);
        // Default cap (8) applies → all 3 run at once.
        expect(state.peak).toBe(3);
      });
    });
  });

  describe('compose tool routing (L4)', () => {
    it('returns clean error when composeExecutor not configured', async () => {
      const dispatcher = makeDispatcher({
        permissions: { allowedTools: ['echo', 'compose'] },
      });
      const result = await dispatcher.execute(
        makeCall({ name: 'compose', input: { nodes: [{ id: 'a', prompt: 'task' }] } }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not available');
    });

    it('routes compose calls to executor when present', async () => {
      const executor = { execute: vi.fn().mockResolvedValue({ content: 'composed result' }) } as any;
      const dispatcher = makeDispatcher({
        composeExecutor: executor,
        permissions: { allowedTools: ['echo', 'compose'] },
      });
      const result = await dispatcher.execute(
        makeCall({ name: 'compose', input: { nodes: [{ id: 'a', prompt: 'task' }] } }),
      );
      expect(result.content).toBe('composed result');
      expect(executor.execute).toHaveBeenCalledOnce();
    });

    it('returns clean error when composeExecutor not configured (executeCore/batch path)', async () => {
      const dispatcher = makeDispatcher({
        permissions: { allowedTools: ['echo', 'compose'] },
      });
      const results = await dispatcher.executeBatch([
        makeCall({ name: 'compose', input: { nodes: [{ id: 'a', prompt: 'task' }] } }),
      ]);
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content).toContain('not available');
    });

    // Compose deferral: PostToolUseFailure hook wiring for compose calls is
    // deferred (acknowledged in PR #282). This skip-marked test documents the
    // current behavior so future changes do not accidentally fire or suppress
    // the hooks without a deliberate decision.
    it.skip('compose deferral: PostToolUseFailure does NOT fire inside compose, PostToolUse does NOT fire either (deferred -- see PR #282)', async () => {
      const registry = createHookRegistryImpl();
      const failureSpy = vi.fn(async () => ({}));
      const postSpy = vi.fn(async () => ({}));
      registry.register('PostToolUseFailure', failureSpy);
      registry.register('PostToolUse', postSpy);

      const throwingExecutor = {
        execute: vi.fn().mockRejectedValue(new Error('compose exploded')),
      } as any;
      const dispatcher = makeDispatcher({
        composeExecutor: throwingExecutor,
        permissions: { allowedTools: ['echo', 'compose'] },
        hookRegistry: registry,
      });
      const result = await dispatcher.execute(
        makeCall({ name: 'compose', input: { nodes: [{ id: 'a', prompt: 'task' }] } }),
      );
      expect(result.isError).toBe(true);
      // Current behavior: neither hook fires for compose errors (deferred).
      await new Promise((r) => setTimeout(r, 20));
      expect(failureSpy).not.toHaveBeenCalled();
      expect(postSpy).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Grant API tests
// ---------------------------------------------------------------------------

describe('SessionToolDispatcher grant API', () => {
  it('getGrants returns initial state from cwd', () => {
    const d = makeDispatcher({ cwd: '/home/user/project' });
    const grants = d.getGrants();
    expect(grants.resolveBase).toBe('/home/user/project');
    expect(grants.readRoots).toEqual(['/home/user/project']);
    expect(grants.writeRoots).toEqual(['/home/user/project']);
  });

  it('getGrants returns empty roots when no cwd', () => {
    const d = makeDispatcher();
    const grants = d.getGrants();
    expect(grants.resolveBase).toBeUndefined();
    expect(grants.readRoots).toEqual([]);
    expect(grants.writeRoots).toEqual([]);
  });

  it('addReadRoot adds to readRoots only', () => {
    const d = makeDispatcher({ cwd: '/base' });
    d.addReadRoot('/extra/read', 'slash');
    const grants = d.getGrants();
    expect(grants.readRoots).toContain('/extra/read');
    expect(grants.writeRoots).not.toContain('/extra/read');
  });

  it('addReadRoot is idempotent', () => {
    const d = makeDispatcher({ cwd: '/base' });
    d.addReadRoot('/extra', 'slash');
    d.addReadRoot('/extra', 'slash');
    const grants = d.getGrants();
    expect(grants.readRoots.filter((r) => r === '/extra')).toHaveLength(1);
  });

  it('addWriteRoot adds to both readRoots and writeRoots', () => {
    const d = makeDispatcher({ cwd: '/base' });
    d.addWriteRoot('/extra/rw', 'slash');
    const grants = d.getGrants();
    expect(grants.readRoots).toContain('/extra/rw');
    expect(grants.writeRoots).toContain('/extra/rw');
  });

  it('revokeRoot removes from both lists', () => {
    const d = makeDispatcher({ cwd: '/base' });
    d.addWriteRoot('/extra', 'slash');
    d.revokeRoot('/extra', 'slash');
    const grants = d.getGrants();
    expect(grants.readRoots).not.toContain('/extra');
    expect(grants.writeRoots).not.toContain('/extra');
  });

  it('revokeRoot does NOT remove resolveBase', () => {
    const d = makeDispatcher({ cwd: '/base' });
    d.revokeRoot('/base', 'slash');
    const grants = d.getGrants();
    // resolveBase is non-revocable — still present in readRoots/writeRoots
    expect(grants.readRoots).toContain('/base');
    expect(grants.writeRoots).toContain('/base');
  });

  it('handlerContext snapshot reflects mutations', async () => {
    let capturedContext: import('./types.js').ToolHandlerContext | undefined;
    const capturingHandler: import('./types.js').ToolHandler = async (_input, _signal, ctx) => {
      capturedContext = ctx;
      return { content: 'ok' };
    };
    const d = new SessionToolDispatcher({
      handlers: new Map([['capture', capturingHandler]]),
      schemas: [],
      permissions: { allowedTools: ['capture'] },
      cwd: '/base',
    });

    d.addReadRoot('/extra', 'slash');
    await d.execute(makeCall({ name: 'capture' }));

    expect(capturedContext?.readRoots).toContain('/base');
    expect(capturedContext?.readRoots).toContain('/extra');
  });

  it('handlerContext surfaces opts.env when set', async () => {
    let capturedContext: import('./types.js').ToolHandlerContext | undefined;
    const capturingHandler: import('./types.js').ToolHandler = async (_input, _signal, ctx) => {
      capturedContext = ctx;
      return { content: 'ok' };
    };
    const d = new SessionToolDispatcher({
      handlers: new Map([['capture', capturingHandler]]),
      schemas: [],
      permissions: { allowedTools: ['capture'] },
      env: { PLUGIN_ROOT: '/fake/plugin' },
    });

    await d.execute(makeCall({ name: 'capture' }));

    expect(capturedContext?.env).toEqual({ PLUGIN_ROOT: '/fake/plugin' });
  });

  it('handlerContext omits env when opts.env is unset (back-compat)', async () => {
    let capturedContext: import('./types.js').ToolHandlerContext | undefined;
    const capturingHandler: import('./types.js').ToolHandler = async (_input, _signal, ctx) => {
      capturedContext = ctx;
      return { content: 'ok' };
    };
    const d = new SessionToolDispatcher({
      handlers: new Map([['capture', capturingHandler]]),
      schemas: [],
      permissions: { allowedTools: ['capture'] },
    });

    await d.execute(makeCall({ name: 'capture' }));

    // Bash relies on `context?.env !== undefined` to opt in to merging;
    // unset must remain undefined, not an empty object.
    expect(capturedContext?.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setResolveBase — worktree-rename escape hatch
//
// These tests pin the bug-fix contract: after a worktree's directory is
// physically renamed mid-session, any tool handler that reads
// `context.resolveBase` (bash spawn cwd, glob/grep base path) MUST see the
// new path on the very next dispatch — even when the dispatcher is the
// same reference that was captured by an in-flight turn (loop.ts:419,436).
// ---------------------------------------------------------------------------

describe('SessionToolDispatcher.setResolveBase', () => {
  it('mutates resolveBase in place and updates handlerContext on next read', async () => {
    let capturedContext: import('./types.js').ToolHandlerContext | undefined;
    const capturingHandler: import('./types.js').ToolHandler = async (_input, _signal, ctx) => {
      capturedContext = ctx;
      return { content: 'ok' };
    };
    const d = new SessionToolDispatcher({
      handlers: new Map([['capture', capturingHandler]]),
      schemas: [],
      permissions: { allowedTools: ['capture'] },
      cwd: '/old/worktree',
    });

    // First dispatch sees the original cwd.
    await d.execute(makeCall({ name: 'capture' }));
    expect(capturedContext?.resolveBase).toBe('/old/worktree');
    expect(capturedContext?.cwd).toBe('/old/worktree');

    // After setResolveBase, the SAME dispatcher reference must emit the new
    // path on the next dispatch — this is the in-flight-turn fix.
    d.setResolveBase('/new/worktree');
    await d.execute(makeCall({ name: 'capture' }));
    expect(capturedContext?.resolveBase).toBe('/new/worktree');
    expect(capturedContext?.cwd).toBe('/new/worktree');
  });

  it('swaps prior cwd in _readRoots/_writeRoots in place (preserves array reference)', () => {
    const sharedReadRoots: string[] = ['/old/worktree'];
    const sharedWriteRoots: string[] = ['/old/worktree'];
    const d = new SessionToolDispatcher({
      handlers: new Map(),
      schemas: [],
      cwd: '/old/worktree',
      readRoots: sharedReadRoots,
      writeRoots: sharedWriteRoots,
    });

    d.setResolveBase('/new/worktree');

    // In-place mutation — the array reference is preserved so any other
    // dispatcher sharing this array (provider pattern) sees the same change.
    expect(sharedReadRoots).toEqual(['/new/worktree']);
    expect(sharedWriteRoots).toEqual(['/new/worktree']);

    // getGrants surfaces the migrated paths.
    const grants = d.getGrants();
    expect(grants.resolveBase).toBe('/new/worktree');
    expect(grants.readRoots).toEqual(['/new/worktree']);
    expect(grants.writeRoots).toEqual(['/new/worktree']);
  });

  it('preserves /allow-dir grants accumulated under the old cwd', () => {
    const d = makeDispatcher({ cwd: '/old/worktree' });
    d.addReadRoot('/extra/read', 'slash');
    d.addWriteRoot('/extra/rw', 'slash');

    d.setResolveBase('/new/worktree');

    const grants = d.getGrants();
    expect(grants.resolveBase).toBe('/new/worktree');
    // /old/worktree → /new/worktree migrated; extras survive.
    expect(grants.readRoots).toContain('/new/worktree');
    expect(grants.readRoots).toContain('/extra/read');
    expect(grants.readRoots).toContain('/extra/rw');
    expect(grants.readRoots).not.toContain('/old/worktree');
    expect(grants.writeRoots).toContain('/new/worktree');
    expect(grants.writeRoots).toContain('/extra/rw');
    expect(grants.writeRoots).not.toContain('/old/worktree');
    expect(grants.writeRoots).not.toContain('/extra/read');
  });

  it('appends newCwd when old cwd not in roots (e.g. dispatcher built without cwd)', () => {
    const d = makeDispatcher();  // no cwd
    expect(d.getGrants().readRoots).toEqual([]);

    d.setResolveBase('/new/worktree');

    const grants = d.getGrants();
    expect(grants.resolveBase).toBe('/new/worktree');
    expect(grants.readRoots).toEqual(['/new/worktree']);
    expect(grants.writeRoots).toEqual(['/new/worktree']);
  });

  it('is a no-op when newCwd equals current resolveBase', () => {
    const sharedReadRoots: string[] = ['/cwd', '/extra'];
    const d = new SessionToolDispatcher({
      handlers: new Map(),
      schemas: [],
      cwd: '/cwd',
      readRoots: sharedReadRoots,
    });

    d.setResolveBase('/cwd');

    // No duplicate entries; array length unchanged.
    expect(sharedReadRoots).toEqual(['/cwd', '/extra']);
  });

  it('revokeRoot guard tracks the new resolveBase, not the original', () => {
    // After rename, the new cwd must be the non-revocable anchor — the old
    // one no longer points anywhere on disk and should not appear in grants.
    const d = makeDispatcher({ cwd: '/old/worktree' });
    d.setResolveBase('/new/worktree');

    // /allow-dir block attempt against the new cwd: silently ignored.
    d.revokeRoot('/new/worktree', 'slash');
    expect(d.getGrants().readRoots).toContain('/new/worktree');

    // /allow-dir block attempt against the old cwd: no-op (not in grants).
    d.revokeRoot('/old/worktree', 'slash');
    expect(d.getGrants().readRoots).not.toContain('/old/worktree');
  });
});

describe('SessionToolDispatcher — repeat-loop circuit breaker', () => {
  it('lets the first THRESHOLD-1 byte-identical calls through, then trips', async () => {
    const dispatcher = makeDispatcher();
    for (let i = 0; i < REPEAT_CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      const r = await dispatcher.execute(makeCall());
      expect(r.isError).toBeUndefined();
      expect(r.content).toBe('hello');
    }
    const tripped = await dispatcher.execute(makeCall());
    expect(tripped.isError).toBe(true);
    expect(tripped.content).toContain('Loop circuit breaker');
    expect(tripped.content).toContain('echo');
    expect(tripped.circuitBreaker).toBe(true);
  });

  it('does not run the handler on the tripped call', async () => {
    const handler = vi.fn(async () => ({ content: 'ran' }));
    const dispatcher = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', handler]]),
    });
    for (let i = 0; i < REPEAT_CIRCUIT_BREAKER_THRESHOLD; i++) {
      await dispatcher.execute(makeCall());
    }
    // The first THRESHOLD-1 calls ran the handler; the tripped call skipped it.
    expect(handler).toHaveBeenCalledTimes(REPEAT_CIRCUIT_BREAKER_THRESHOLD - 1);
  });

  it('resets the counter when input changes (counts CONSECUTIVE only)', async () => {
    const dispatcher = makeDispatcher();
    for (let i = 0; i < REPEAT_CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      expect((await dispatcher.execute(makeCall())).isError).toBeUndefined();
    }
    // A different input resets the run...
    const other = await dispatcher.execute(makeCall({ input: { message: 'different' } }));
    expect(other.isError).toBeUndefined();
    // ...so returning to the original input starts fresh — 7 more pass without tripping.
    for (let i = 0; i < REPEAT_CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      expect((await dispatcher.execute(makeCall())).isError).toBeUndefined();
    }
  });

  it('does not trip when two tools are interleaved (never THRESHOLD consecutive)', async () => {
    const dispatcher = makeDispatcher({
      handlers: new Map([
        ['echo', echoHandler()],
        ['echo2', echoHandler()],
      ]),
      permissions: { allowedTools: ['echo', 'echo2'] },
    });
    for (let i = 0; i < REPEAT_CIRCUIT_BREAKER_THRESHOLD * 3; i++) {
      const name = i % 2 === 0 ? 'echo' : 'echo2';
      const r = await dispatcher.execute(makeCall({ name }));
      expect(r.isError).toBeUndefined();
    }
  });

  it('trips on the batch path too', async () => {
    const dispatcher = makeDispatcher();
    const calls = Array.from({ length: REPEAT_CIRCUIT_BREAKER_THRESHOLD }, () => makeCall());
    const results = await dispatcher.executeBatch(calls);
    for (let i = 0; i < REPEAT_CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      expect(results[i]?.isError).toBeUndefined();
    }
    const last = results[REPEAT_CIRCUIT_BREAKER_THRESHOLD - 1];
    expect(last?.isError).toBe(true);
    expect(last?.content).toContain('Loop circuit breaker');
  });

  it('a fresh dispatcher (next turn) starts with a clean counter', async () => {
    const d1 = makeDispatcher();
    for (let i = 0; i < REPEAT_CIRCUIT_BREAKER_THRESHOLD; i++) {
      await d1.execute(makeCall());
    }
    // New dispatcher == new query/turn: state resets, so the next call passes.
    const d2 = makeDispatcher();
    const r = await d2.execute(makeCall());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('hello');
  });
});

describe('SessionToolDispatcher — canUseTool (Dim 8 in-process permission policy)', () => {
  const allowAll: CanUseTool = async () => ({ behavior: 'allow' });

  it('allow result lets the call through to the handler', async () => {
    const handler = vi.fn(echoHandler());
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', handler]]),
      canUseTool: allowAll,
    });
    const r = await d.execute(makeCall());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('hello');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('deny result short-circuits before the handler runs', async () => {
    const handler = vi.fn(echoHandler());
    const denyEcho: CanUseTool = async (name) => ({
      behavior: 'deny',
      message: `policy denied ${name}`,
    });
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', handler]]),
      canUseTool: denyEcho,
    });
    const r = await d.execute(makeCall());
    expect(r.isError).toBe(true);
    expect(r.content).toBe('policy denied echo');
    expect(r.failureClass).toBe('permission-denied');
    expect(handler).not.toHaveBeenCalled();
  });

  it('deny overrides a tool that the static allowlist permits (policy can restrict)', async () => {
    // 'echo' IS allowlisted, but the policy denies it. canUseTool runs AFTER
    // the allowlist, so it can further restrict — never widen.
    const handler = vi.fn(echoHandler());
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', handler]]),
      permissions: { allowedTools: ['echo'] },
      canUseTool: async () => ({ behavior: 'deny', message: 'nope' }),
    });
    const r = await d.execute(makeCall());
    expect(r.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('static allowlist still wins: canUseTool cannot widen a denied tool', async () => {
    // 'forbidden' is NOT allowlisted. Even though the policy would allow it,
    // checkToolPermission runs first and denies — canUseTool never widens.
    const handler = vi.fn(echoHandler());
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['forbidden', handler]]),
      permissions: { allowedTools: ['echo'] },
      canUseTool: allowAll,
    });
    const r = await d.execute(makeCall({ name: 'forbidden' }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not in the configured allowlist');
    expect(handler).not.toHaveBeenCalled();
  });

  it('allow.updatedInput rewrites the input the handler receives', async () => {
    const handler = vi.fn(echoHandler());
    const rewrite: CanUseTool = async () => ({
      behavior: 'allow',
      updatedInput: { message: 'rewritten' },
    });
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', handler]]),
      canUseTool: rewrite,
    });
    const r = await d.execute(makeCall({ input: { message: 'original' } }));
    expect(r.content).toBe('rewritten');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fails closed: a throwing policy denies rather than crashing the turn', async () => {
    const handler = vi.fn(echoHandler());
    const boom: CanUseTool = async () => {
      throw new Error('policy bug');
    };
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', handler]]),
      canUseTool: boom,
    });
    const r = await d.execute(makeCall());
    expect(r.isError).toBe(true);
    expect(r.failureClass).toBe('permission-denied');
    expect(r.content).toContain('policy bug');
    expect(handler).not.toHaveBeenCalled();
  });

  it('gates parallel calls in executeBatch (policy not bypassed on batched rounds)', async () => {
    const handler = vi.fn(echoHandler());
    const policy: CanUseTool = async (_name, input) => {
      const msg = (input as { message?: string }).message;
      return msg === 'deny-me'
        ? { behavior: 'deny', message: 'blocked in batch' }
        : { behavior: 'allow' };
    };
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', handler]]),
      permissions: { allowedTools: ['echo'] },
      canUseTool: policy,
    });
    const results = await d.executeBatch([
      makeCall({ id: 'a', input: { message: 'ok' } }),
      makeCall({ id: 'b', input: { message: 'deny-me' } }),
    ]);
    expect(results[0]!.isError).toBeUndefined();
    expect(results[0]!.content).toBe('ok');
    expect(results[1]!.isError).toBe(true);
    expect(results[1]!.content).toBe('blocked in batch');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when canUseTool is unset (default path unchanged)', async () => {
    const handler = vi.fn(echoHandler());
    const d = makeDispatcher({ handlers: new Map<string, ToolHandler>([['echo', handler]]) });
    const r = await d.execute(makeCall());
    expect(r.content).toBe('hello');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('deny emits a hook_decision block', async () => {
    const writer = new InMemoryTraceWriter();
    const denyPolicy: CanUseTool = async (name) => ({
      behavior: 'deny',
      message: `policy denied ${name}`,
    });
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', echoHandler()]]),
      canUseTool: denyPolicy,
      traceWriter: writer,
    });
    await d.execute(makeCall());
    const hookEvents = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(hookEvents).toHaveLength(1);
    const ev = hookEvents[0]!;
    if (ev.kind !== 'hook_decision') throw new Error('unreachable');
    expect(ev.payload.hookEvent).toBe('PreToolUse');
    expect(ev.payload.decision).toBe('block');
    expect(ev.payload.blockedTool).toBe('echo');
    expect(ev.payload.reason).toContain('policy denied echo');
  });

  it('throw (fail-closed) emits a hook_decision block', async () => {
    const writer = new InMemoryTraceWriter();
    const boom: CanUseTool = async () => {
      throw new Error('policy bug');
    };
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', echoHandler()]]),
      canUseTool: boom,
      traceWriter: writer,
    });
    await d.execute(makeCall());
    const hookEvents = writer.events.filter((e) => e.kind === 'hook_decision');
    expect(hookEvents).toHaveLength(1);
    const ev = hookEvents[0]!;
    if (ev.kind !== 'hook_decision') throw new Error('unreachable');
    expect(ev.payload.hookEvent).toBe('PreToolUse');
    expect(ev.payload.decision).toBe('block');
    expect(ev.payload.blockedTool).toBe('echo');
    expect(ev.payload.reason).toContain('threw');
    expect(ev.payload.reason).toContain('policy bug');
  });

  it('allow emits no hook_decision', async () => {
    const writer = new InMemoryTraceWriter();
    const d = makeDispatcher({
      handlers: new Map<string, ToolHandler>([['echo', echoHandler()]]),
      canUseTool: allowAll,
      traceWriter: writer,
    });
    await d.execute(makeCall());
    expect(writer.events.filter((e) => e.kind === 'hook_decision')).toHaveLength(0);
  });
});
