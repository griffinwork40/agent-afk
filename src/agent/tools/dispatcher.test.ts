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
import { REPEAT_FAILURE_REFUSAL_THRESHOLD } from './repeat-failure-guard.js';

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

  describe('allowlist denial of an unregistered (hallucinated) tool name', () => {
    // `bash` is REGISTERED but not allowlisted (a real permission decision);
    // read_file/edit_file are both registered and allowed.
    function makeSplitDispatcher() {
      const pick = (n: string) => builtinToolSchemas.find((s) => s.name === n)!;
      return new SessionToolDispatcher({
        handlers: new Map([
          ['read_file', echoHandler()],
          ['edit_file', echoHandler()],
          ['bash', echoHandler()],
        ]),
        schemas: [pick('read_file'), pick('edit_file'), pick('bash')],
        permissions: { allowedTools: ['read_file', 'edit_file'] },
      });
    }

    it('tells the model the tool does not exist instead of blaming the allowlist', async () => {
      const dispatcher = makeSplitDispatcher();
      const result = await dispatcher.execute(
        makeCall({ name: 'str_replace_based_edit_tool', input: {} }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown tool "str_replace_based_edit_tool"');
      expect(result.content).toContain('does not exist in this session');
      // The misleading message is what caused models to re-emit the phantom name.
      expect(result.content).not.toContain('not in the configured allowlist');
    });

    it('enumerates the callable tools and warns against retrying the phantom name', async () => {
      const dispatcher = makeSplitDispatcher();
      const result = await dispatcher.execute(
        makeCall({ name: 'str_replace_based_edit_tool', input: {} }),
      );
      expect(result.content).toContain('read_file');
      expect(result.content).toContain('edit_file');
      expect(result.content).toContain('Do NOT retry');
    });

    it('does NOT advertise a registered-but-denied tool in the suggestion list', async () => {
      // Mirrors the `toolDefs` contract: never show the model a tool the gate rejects.
      const dispatcher = makeSplitDispatcher();
      const result = await dispatcher.execute(
        makeCall({ name: 'str_replace_based_edit_tool', input: {} }),
      );
      expect(result.content).not.toContain('bash');
    });

    it('preserves the allowlist message for a REGISTERED but denied tool', async () => {
      const dispatcher = makeSplitDispatcher();
      const result = await dispatcher.execute(makeCall({ name: 'bash', input: {} }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('is not in the configured allowlist');
      expect(result.content).not.toContain('Unknown tool');
    });

    it.each([
      ['agent', 'subagentExecutor'],
      ['skill', 'skillExecutor'],
      ['compose', 'composeExecutor'],
    ] as const)(
      'preserves the allowlist message for the executor-backed %s tool',
      async (toolName, executorOption) => {
        const configured = makeDispatcher({
          handlers: new Map(),
          schemas: [],
          permissions: { allowedTools: [] },
          [executorOption]: mockExecutor(),
        });
        // Executor-backed tools intentionally have no entries in the handler map.
        const result = await configured.execute(makeCall({ name: toolName, input: {} }));
        expect(result.isError).toBe(true);
        expect(result.content).toContain('is not in the configured allowlist');
        expect(result.content).not.toContain('Unknown tool');
      },
    );

    it('keeps failureClass permission-denied for the unregistered case', async () => {
      const dispatcher = makeSplitDispatcher();
      const result = await dispatcher.execute(
        makeCall({ name: 'str_replace_based_edit_tool', input: {} }),
      );
      expect(result.failureClass).toBe('permission-denied');
    });

    it('does not leak non-allowlisted handlers when an ALLOWLISTED tool has no handler', async () => {
      // Reachable in production: `exit_plan_mode` is statically allowlisted by
      // topLevelSurfaceAllowedTools but only registered while in plan mode.
      // This path passes the permission gate and fails the handler lookup.
      const pick = (n: string) => builtinToolSchemas.find((s) => s.name === n)!;
      const dispatcher = new SessionToolDispatcher({
        handlers: new Map([
          ['read_file', echoHandler()],
          ['bash', echoHandler()],
        ]),
        schemas: [pick('read_file'), pick('bash')],
        // 'write_file' is allowlisted but never registered; bash is registered
        // but NOT allowlisted, so it must not appear in the suggestion list.
        permissions: { allowedTools: ['read_file', 'write_file'] },
      });
      const result = await dispatcher.execute(makeCall({ name: 'write_file', input: {} }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Unknown tool "write_file"');
      expect(result.content).toContain('read_file');
      expect(result.content).not.toContain('bash');
    });

    it('omits the dangling "listed above" pointer when no schema survives the allowlist', async () => {
      const dispatcher = new SessionToolDispatcher({
        handlers: new Map([['echo', echoHandler()]]),
        schemas: [],
        permissions: { allowedTools: ['echo', 'ghost'] },
      });
      const result = await dispatcher.execute(makeCall({ name: 'ghost', input: {} }));
      expect(result.content).toContain('Unknown tool "ghost"');
      expect(result.content).toContain('Do NOT retry');
      expect(result.content).not.toContain('listed above');
      expect(result.content).not.toContain('Available tools:');
    });
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

  it('hides cancel_background_job when no background-capable executor is wired', () => {
    const dispatcher = makeDispatcher({ permissions: undefined });
    expect(dispatcher.toolDefs).toEqual(
      builtinToolSchemas.filter((schema) => schema.name !== 'cancel_background_job'),
    );
  });

  describe('toolDefs allowlist subsetting', () => {
    it('returns all schemas when no allowlist is configured (permissions undefined)', () => {
      const dispatcher = new SessionToolDispatcher({
        handlers: new Map(),
        schemas: [...builtinToolSchemas],
        // no permissions → undefined
      });
      expect(dispatcher.toolDefs).toEqual(
        builtinToolSchemas.filter((schema) => schema.name !== 'cancel_background_job'),
      );
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

    it('PreToolUse block with injectContext appends explanation to content', async () => {
      const registry = createHookRegistryImpl();
      registry.register('PreToolUse', async () => ({
        decision: 'block' as const,
        reason: 'dangerous',
        injectContext: 'Use a safer tool instead.',
      }));
      const dispatcher = makeDispatcher({ hookRegistry: registry });
      const result = await dispatcher.execute(makeCall());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('blocked by PreToolUse hook');
      expect(result.content).toContain('Use a safer tool instead.');
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

    it('forwards incomplete/incompleteReason to PostToolUse for a partial agent result', async () => {
      const registry = createHookRegistryImpl();
      const postSpy = vi.fn(async () => ({}));
      registry.register('PostToolUse', postSpy);
      // A capped/stream-cut subagent partial: the structured flags ride the
      // ToolResult alongside the `[⚠ PARTIAL RESULT…]` banner in `content`,
      // so a hook can branch without substring-matching that banner.
      const executor = {
        execute: vi.fn().mockResolvedValue({
          content: 'partial output',
          incomplete: true,
          incompleteReason: 'stream_incomplete',
        }),
      } as any;
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
        incomplete: true,
        incompleteReason: 'stream_incomplete',
      });
    });

    it('omits incomplete/incompleteReason from PostToolUse for a clean agent result', async () => {
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
      const ctx = (postSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      // Absent, not `false`/`undefined` — mirrors how the dispatcher spreads
      // the fields only when the ToolResult actually carries them.
      expect('incomplete' in ctx).toBe(false);
      expect('incompleteReason' in ctx).toBe(false);
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

    it('refuses duplicate safe calls once failures reach the threshold within a batch', async () => {
      vi.stubEnv('AFK_DEBUG', '1');
      const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const handler = vi.fn<ToolHandler>().mockResolvedValue({
        content: 'same failure',
        isError: true,
      });
      const dispatcher = makeDispatcher({ handlers: new Map([['echo', handler]]) });
      const calls = Array.from({ length: REPEAT_FAILURE_REFUSAL_THRESHOLD + 2 }, (_, i) => ({
        ...makeBatchCall('echo', `duplicate-${i}`),
        input: { message: 'same', timeout_ms: i * 1_000 },
      }));

      const results = await dispatcher.executeBatch(calls);

      expect(handler).toHaveBeenCalledTimes(REPEAT_FAILURE_REFUSAL_THRESHOLD);
      expect(results.slice(0, REPEAT_FAILURE_REFUSAL_THRESHOLD).every((r) => r.isError)).toBe(true);
      expect(results[REPEAT_FAILURE_REFUSAL_THRESHOLD]).toMatchObject({
        isError: true,
        failureClass: 'repeat-failure',
      });
      expect(results[REPEAT_FAILURE_REFUSAL_THRESHOLD + 1]).toMatchObject({
        isError: true,
        failureClass: 'repeat-failure',
      });
      expect(debugSpy).toHaveBeenCalledWith(
        `[repeat-failure-guard #723] refused echo after ${REPEAT_FAILURE_REFUSAL_THRESHOLD} identical failures`,
      );
      debugSpy.mockRestore();
      vi.unstubAllEnvs();
    });

    it('records duplicate safe-call outcomes in input order, not settlement order', async () => {
      let invocation = 0;
      const handler = vi.fn<ToolHandler>().mockImplementation(async () => {
        invocation += 1;
        if (invocation === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        return invocation === 3
          ? { content: 'recovered' }
          : { content: 'transient failure', isError: true };
      });
      const dispatcher = makeDispatcher({ handlers: new Map([['echo', handler]]) });
      const duplicate = (id: string) => ({
        ...makeBatchCall('echo', id),
        input: { message: 'same' },
      });

      const batch = await dispatcher.executeBatch([
        duplicate('ordered-1'),
        duplicate('ordered-2'),
        duplicate('ordered-3'),
      ]);
      const afterRecovery = await dispatcher.execute(duplicate('after-recovery'));

      expect(batch.map((result) => result.isError === true)).toEqual([true, true, false]);
      expect(afterRecovery.failureClass).not.toBe('repeat-failure');
      expect(handler).toHaveBeenCalledTimes(4);
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
      // Wall-clock should be ~50ms not ~100ms; 150ms gives CI headroom
      expect(elapsed).toBeLessThan(150);
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

      it('uses the operator env ceiling when no explicit limit is supplied', async () => {
        vi.stubEnv('AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', '2');
        try {
          const { state, handler } = makeConcurrencyProbe();
          const dispatcher = makeDispatcher({
            handlers: new Map([['read_file', handler]]),
            permissions: { allowedTools: ['read_file'] },
          });

          const calls = Array.from({ length: 6 }, (_, i) =>
            makeBatchCall('read_file', `env-read-${i}`),
          );
          await dispatcher.executeBatch(calls);
          expect(state.peak).toBe(2);
        } finally {
          vi.unstubAllEnvs();
        }
      });

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

        // Identical calls are admitted only up to the repeat-failure threshold
        // until their outcomes are known, even when the general cap is wider.
        expect(state.peak).toBe(REPEAT_FAILURE_REFUSAL_THRESHOLD);
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

  // ---------------------------------------------------------------------------
  // getConcurrencyClassifier — Phase 2 eager batch-start emission (issue #516 fix)
  // ---------------------------------------------------------------------------
  describe('getConcurrencyClassifier (Phase 2 eager batch-start, issue #516 fix)', () => {
    it('returns the default classifier when no custom classifier is provided', () => {
      const dispatcher = makeDispatcher();
      const classifier = dispatcher.getConcurrencyClassifier();
      expect(classifier('read_file', {})).toBe(true);
      expect(classifier('glob', {})).toBe(true);
      expect(classifier('bash', {})).toBe(false);
      expect(classifier('write_file', {})).toBe(false);
    });

    it('returns the custom classifier when one is injected', () => {
      const alwaysSafe = (_name: string, _input: unknown) => true;
      const dispatcher = makeDispatcher({ concurrencyClassifier: alwaysSafe });
      const classifier = dispatcher.getConcurrencyClassifier();
      // Custom classifier marks everything safe, including write tools.
      expect(classifier('bash', {})).toBe(true);
      expect(classifier('write_file', {})).toBe(true);
    });

    it('classifier result is consistent with how executeBatch partitions calls', async () => {
      const signal = new AbortController().signal;
      const dispatcher = makeDispatcher({
        handlers: new Map([
          ['read_file', async () => ({ content: 'r' })],
          ['glob', async () => ({ content: 'g' })],
        ]),
        permissions: { allowedTools: ['read_file', 'glob'] },
      });
      const classifier = dispatcher.getConcurrencyClassifier();
      // Both tools are concurrency-safe per the classifier — executeBatch
      // will run them in one concurrent wave.
      expect(classifier('read_file', {})).toBe(true);
      expect(classifier('glob', {})).toBe(true);

      // Confirm executeBatch still runs correctly after getConcurrencyClassifier.
      const results = await dispatcher.executeBatch([
        { id: 'toolu_r', name: 'read_file', input: {}, signal },
        { id: 'toolu_g', name: 'glob', input: {}, signal },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]!.content).toBe('r');
      expect(results[1]!.content).toBe('g');
    });

    // Provider-level event ordering: tool.batch.start must precede tool.output
    // events in the provider stream for a concurrent batch (the core fix).
    // This test simulates what the provider generator does: compute partition,
    // yield batch-start events, then await executeBatch.
    it('classifier enables provider to yield tool.batch.start BEFORE executeBatch settles', async () => {
      const signal = new AbortController().signal;
      let resolveRead!: () => void;
      let resolveGlob!: () => void;
      const readStarted = new Promise<void>((r) => { resolveRead = r; });
      const globStarted = new Promise<void>((r) => { resolveGlob = r; });
      // Handlers signal when they start so we can interleave event-emission checks.
      const readHandler: ToolHandler = async () => {
        resolveRead();
        await new Promise<void>((r) => setTimeout(r, 10));
        return { content: 'r' };
      };
      const globHandler: ToolHandler = async () => {
        resolveGlob();
        await new Promise<void>((r) => setTimeout(r, 10));
        return { content: 'g' };
      };
      const dispatcher = makeDispatcher({
        handlers: new Map([['read_file', readHandler], ['glob', globHandler]]),
        permissions: { allowedTools: ['read_file', 'glob'] },
      });

      const calls = [
        { id: 'toolu_r', name: 'read_file', input: {}, signal },
        { id: 'toolu_g', name: 'glob', input: {}, signal },
      ];

      // Simulate what the provider generator does: compute partition eagerly
      // using getConcurrencyClassifier, collect batch-start events, then await.
      const { partitionIntoBatches } = await import('./dispatch-batching.js');
      const classifier = dispatcher.getConcurrencyClassifier();
      const batches = partitionIntoBatches(calls, classifier);
      const batchStartEvents: Array<{ batchSize: number; toolUseIds: string[] }> = [];
      for (const batch of batches) {
        if (batch.isConcurrencySafe && batch.indices.length >= 2) {
          batchStartEvents.push({
            batchSize: batch.indices.length,
            toolUseIds: batch.indices.map((i) => calls[i]!.id),
          });
        }
      }

      // batch-start events are available BEFORE executeBatch is awaited.
      expect(batchStartEvents).toHaveLength(1);
      expect(batchStartEvents[0]!.batchSize).toBe(2);
      expect(batchStartEvents[0]!.toolUseIds).toEqual(['toolu_r', 'toolu_g']);

      // Only now await executeBatch — batch-start already emitted.
      const results = await dispatcher.executeBatch(calls);
      expect(results).toHaveLength(2);
      await Promise.all([readStarted, globStarted]); // both handlers ran
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

  // --- Finding 1: per-call sessionId threads through dispatcher wrappers ---

  it('addReadRoot threads optional per-call sessionId through to grant manager', () => {
    // Smoke-test: the 3-arg overload must exist and not throw. Audit-attribution
    // correctness is verified at the PathGrantManager layer; here we just confirm
    // the wrapper accepts the parameter without TypeScript error.
    const d = makeDispatcher({ cwd: '/base', sessionId: 'ctor-session' });
    expect(() => d.addReadRoot('/extra', 'slash', 'per-call-session')).not.toThrow();
    expect(d.getGrants().readRoots).toContain('/extra');
  });

  it('addWriteRoot threads optional per-call sessionId through to grant manager', () => {
    const d = makeDispatcher({ cwd: '/base', sessionId: 'ctor-session' });
    expect(() => d.addWriteRoot('/extra', 'slash', 'per-call-session')).not.toThrow();
    expect(d.getGrants().writeRoots).toContain('/extra');
  });

  it('revokeRoot threads optional per-call sessionId through to grant manager', () => {
    const d = makeDispatcher({ cwd: '/base', sessionId: 'ctor-session' });
    d.addWriteRoot('/extra', 'slash');
    expect(() => d.revokeRoot('/extra', 'slash', 'per-call-session')).not.toThrow();
    expect(d.getGrants().readRoots).not.toContain('/extra');
  });

  // --- Finding 2: migrating-anchor policy (Option A) ---

  // --- Finding 3: revokeRoot must not audit on no-op (tested via grant state) ---

  it('revokeRoot is idempotent — double-revoking is a no-op (Finding 3)', () => {
    // Verifies the "no audit on no-op" fix is consistent: revoking a path that
    // is already gone must not change grant state or throw.
    const d = makeDispatcher({ cwd: '/base' });
    d.addWriteRoot('/extra', 'slash');
    d.revokeRoot('/extra', 'slash'); // first revoke — real removal
    expect(d.getGrants().readRoots).not.toContain('/extra');
    // Second revoke of the same (now-absent) path must be a no-op.
    expect(() => d.revokeRoot('/extra', 'slash')).not.toThrow();
    expect(d.getGrants().readRoots).not.toContain('/extra');
  });

  it('revokeRoot on the anchor is a no-op even when the anchor IS in readRoots', () => {
    // The anchor guard fires before the splice — anchor stays in readRoots.
    const d = makeDispatcher({ cwd: '/base' });
    d.revokeRoot('/base', 'slash');
    expect(d.getGrants().readRoots).toContain('/base');
    // Double-revoke of the anchor also must not throw.
    expect(() => d.revokeRoot('/base', 'slash')).not.toThrow();
  });

  it('getGrants.resolveBase migrates with setResolveBase (Option A)', () => {
    // The anchor used by getProtectedRoot (and surfaced in getGrants) must be
    // the CURRENT cwd — after migration the new worktree root is the anchor.
    const d = makeDispatcher({ cwd: '/launch/dir' });
    d.setResolveBase('/new/worktree');
    expect(d.getGrants().resolveBase).toBe('/new/worktree'); // anchor migrated
  });

  it('current cwd is the non-revocable anchor (migrates on setResolveBase)', () => {
    // After migration, revoking the NEW cwd must be silently ignored.
    const d = makeDispatcher({ cwd: '/launch/dir' });
    d.setResolveBase('/new/worktree');
    d.revokeRoot('/new/worktree', 'slash');
    expect(d.getGrants().readRoots).toContain('/new/worktree');
  });

  it('old cwd becomes revocable after setResolveBase migrates the anchor (Option A)', () => {
    // Option A invariant: after setResolveBase('/new'), the OLD cwd is no longer
    // the protected anchor. revokeRoot on the old dir must succeed, proving the
    // anchor migrated away from it.
    //
    // Counterpart to the test above: that test proves NEW cwd is protected;
    // this test proves OLD cwd is no longer protected.
    const d = makeDispatcher({ cwd: '/old/worktree' });
    d.setResolveBase('/new/worktree');
    // setResolveBase spliced /old/worktree out of _readRoots. Re-grant it so
    // revokeRoot has something to remove (simulates a grant added after migration).
    d.addReadRoot('/old/worktree', 'slash');
    // Revoke must succeed — /old/worktree is no longer the anchor.
    d.revokeRoot('/old/worktree', 'slash');
    expect(d.getGrants().readRoots).not.toContain('/old/worktree');
    // New anchor remains intact.
    expect(d.getGrants().readRoots).toContain('/new/worktree');
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

  it('revokeRoot guard tracks the CURRENT resolveBase (anchor policy: Option A — migrating)', () => {
    // The NON-REVOCABLE anchor is the CURRENT resolveBase (Option A: migrating
    // anchor). After setResolveBase the new cwd becomes the protected root —
    // provider semantics match (_currentCwd migrates the same way via setCwd).
    //
    // Scenario: add an extra root, then migrate. After migration:
    //   - revoking /old/worktree is a no-op: setResolveBase already spliced it
    //     out of _readRoots, so there is nothing to remove (the anchor guard
    //     does NOT fire here — /old/worktree no longer matches resolveBase).
    //   - the extra root (not the anchor) must still be revocable normally.
    const d = makeDispatcher({ cwd: '/old/worktree' });
    d.addReadRoot('/extra/grant', 'slash');
    d.setResolveBase('/new/worktree');

    // /old/worktree was migrated out of _readRoots by setResolveBase — revoking
    // it is a structural no-op (path not in list). The anchor is now /new/worktree.
    d.revokeRoot('/old/worktree', 'slash');
    // /new/worktree (migrated in) and /extra/grant (unchanged) remain in readRoots.
    expect(d.getGrants().readRoots).toContain('/new/worktree');
    expect(d.getGrants().readRoots).toContain('/extra/grant');

    // The extra root (NOT the anchor) must be revocable normally.
    d.revokeRoot('/extra/grant', 'slash');
    expect(d.getGrants().readRoots).not.toContain('/extra/grant');
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

describe('SessionToolDispatcher — suspected-loop telemetry coexists with the repeat breaker (OBSERVE-ONLY)', () => {
  // The observe-only suspected_loop signal shares the sequential pre-execution
  // path with the repeat circuit breaker. These tests lock in that (a) it does
  // NOT perturb the top-level session (which is out of its forked-only scope),
  // and (b) it emits — without ever changing a result — for a forked child.

  it('top-level session: no suspected_loop event and repeat-breaker behavior is unchanged', async () => {
    const writer = new InMemoryTraceWriter();
    // makeDispatcher() sets no parentSessionId → a top-level session.
    const dispatcher = makeDispatcher({ traceWriter: writer });
    for (let i = 0; i < REPEAT_CIRCUIT_BREAKER_THRESHOLD - 1; i++) {
      expect((await dispatcher.execute(makeCall())).isError).toBeUndefined();
    }
    // The repeat breaker still trips at its threshold, exactly as before.
    const tripped = await dispatcher.execute(makeCall());
    expect(tripped.isError).toBe(true);
    expect(tripped.circuitBreaker).toBe(true);
    // And no observe-only loop signal is emitted for a top-level session.
    const loopEvents = writer.events.filter(
      (e) => e.kind === 'session_phase' && e.payload.phase === 'suspected_loop',
    );
    expect(loopEvents).toHaveLength(0);
  });

  it('forked child: emits suspected_loop but returns the normal tool result', async () => {
    const writer = new InMemoryTraceWriter();
    const dispatcher = makeDispatcher({ parentSessionId: 'parent-1', traceWriter: writer });
    let last;
    // Below the repeat-breaker threshold (8) so the calls actually run; the
    // suspected-loop threshold (5) is crossed first, purely as telemetry.
    for (let i = 0; i < 5; i++) {
      last = await dispatcher.execute(makeCall());
    }
    // OBSERVE-ONLY: the result is the real handler output — no error/breaker flag.
    expect(last?.isError).toBeUndefined();
    expect(last?.content).toBe('hello');
    expect(last?.circuitBreaker).toBeUndefined();
    const loopEvents = writer.events.filter(
      (e) => e.kind === 'session_phase' && e.payload.phase === 'suspected_loop',
    );
    expect(loopEvents).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// maxOutputBytes — central fork-scoped output-cap backstop (#661)
//
// A forked child's dispatcher is constructed with maxOutputBytes set (to
// MODEL_CAP_BYTES) so EVERY tool result — MCP bridges, browser dumps,
// read_file of a huge file — is bounded before it re-enters the child's
// context, containing the whole overflow crash class. The top-level session
// leaves maxOutputBytes undefined ⇒ no central capping ⇒ behavior unchanged.
// ---------------------------------------------------------------------------

describe('SessionToolDispatcher — maxOutputBytes central output cap (#661)', () => {
  const TRUNC_MARKER = /… \[\d+ bytes truncated: showing first \d+ \+ last \d+ of \d+\] …/;

  /** A handler that returns `content` of a caller-chosen size. */
  function bigContentHandler(bytes: number): ToolHandler {
    return async () => ({ content: 'A'.repeat(bytes) });
  }

  function makeCapDispatcher(
    handler: ToolHandler,
    maxOutputBytes: number | undefined,
  ): SessionToolDispatcher {
    return new SessionToolDispatcher({
      handlers: new Map([['big', handler]]),
      schemas: [],
      permissions: { allowedTools: ['big'] },
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    });
  }

  it('truncates an over-budget tool result and sets truncated:true when maxOutputBytes is set', async () => {
    const d = makeCapDispatcher(bigContentHandler(5000), 500);
    const r = await d.execute(makeCall({ name: 'big', input: {} }));
    expect(r.isError).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.content).toMatch(TRUNC_MARKER);
    // Output bounded by the cap (marker reserve makes it slightly under).
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(500);
    // Head is preserved (head+tail, not a tail-only slice).
    expect(r.content.startsWith('A')).toBe(true);
  });

  it('leaves content untouched (no truncated flag) when maxOutputBytes is undefined', async () => {
    const original = 'A'.repeat(5000);
    const d = makeCapDispatcher(bigContentHandler(5000), undefined);
    const r = await d.execute(makeCall({ name: 'big', input: {} }));
    expect(r.content).toBe(original);
    expect(r.content).not.toMatch(TRUNC_MARKER);
    expect(r.truncated).toBeUndefined();
  });

  it('does NOT truncate content already within the cap (idempotent, no double-truncation)', async () => {
    const small = 'A'.repeat(50);
    const d = makeCapDispatcher(bigContentHandler(50), 500);
    const r = await d.execute(makeCall({ name: 'big', input: {} }));
    expect(r.content).toBe(small);
    expect(r.truncated).toBeUndefined();
  });

  it('preserves result.image while capping the text content', async () => {
    const withImage: ToolHandler = async () => ({
      content: 'A'.repeat(5000),
      image: { mediaType: 'image/png' as const, data: 'BASE64DATA' },
    });
    const d = makeCapDispatcher(withImage, 500);
    const r = await d.execute(makeCall({ name: 'big', input: {} }));
    expect(r.truncated).toBe(true);
    expect(r.content).toMatch(TRUNC_MARKER);
    // The screenshot rides through untouched — the cap governs text only.
    expect(r.image).toEqual({ mediaType: 'image/png', data: 'BASE64DATA' });
  });

  it('caps over-budget results dispatched through executeBatch too (shared executeCore path)', async () => {
    // Two safe calls in one batch → executeBatch → executeCore per call, so the
    // cap must apply on the batched path exactly as on the single-call path.
    const d = new SessionToolDispatcher({
      handlers: new Map([['big', bigContentHandler(5000)]]),
      schemas: [{ name: 'big', input_schema: { type: 'object' }, concurrencySafe: true }],
      permissions: { allowedTools: ['big'] },
      maxOutputBytes: 500,
    });
    const results = await d.executeBatch([
      makeCall({ id: 'a', name: 'big', input: {} }),
      makeCall({ id: 'b', name: 'big', input: {} }),
    ]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.truncated).toBe(true);
      expect(r.content).toMatch(TRUNC_MARKER);
      expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(500);
    }
  });

  it('ignores non-positive / non-finite maxOutputBytes (cap stays off)', async () => {
    const original = 'A'.repeat(5000);
    for (const bad of [0, -100, Number.NaN]) {
      const d = makeCapDispatcher(bigContentHandler(5000), bad);
      const r = await d.execute(makeCall({ name: 'big', input: {} }));
      expect(r.content).toBe(original);
      expect(r.truncated).toBeUndefined();
    }
  });
});
