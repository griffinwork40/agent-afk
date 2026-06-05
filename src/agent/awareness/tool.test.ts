/**
 * Tests for the `get_runtime_state` tool handler factory + schema.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getRuntimeStateTool,
  createGetRuntimeStateHandler,
  wrapDispatcherWithRuntimeState,
} from './tool.js';
import type { RuntimeStateSource } from './types.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { ToolDispatcher } from '../providers/anthropic-direct/tool-dispatcher.js';
import type { AnthropicToolDef } from '../tools/types.js';

function mkSource(): RuntimeStateSource {
  return {
    getSelf: () => ({
      sessionId: 'sid-1234',
      surface: 'repl',
      parentSessionId: null,
      depth: null,
      maxDepth: null,
      phaseRole: null,
      cwd: '/work',
      model: { provider: 'anthropic-direct', name: 'sonnet' },
      permissionMode: 'default',
    }),
    getTools: () => ({
      enabled: ['bash', 'read_file', 'get_runtime_state'],
      mcpServers: [],
    }),
    getSubagents: () => ({ active: [], backgroundJobs: [] }),
    getWorkspace: () => ({ branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null }),
  };
}

describe('getRuntimeStateTool schema', () => {
  it('declares the canonical name and read-class semantics', () => {
    expect(getRuntimeStateTool.name).toBe('get_runtime_state');
    expect(getRuntimeStateTool.concurrencySafe).toBe(true);
  });

  it('exposes the five supported views in the JSON schema enum', () => {
    const props = getRuntimeStateTool.input_schema.properties as Record<string, unknown>;
    const view = props['view'] as { enum?: string[] };
    expect(view.enum).toEqual(['self', 'tools', 'subagents', 'workspace', 'all']);
  });

  it('marks no fields as required (view is optional, defaults to all)', () => {
    expect(getRuntimeStateTool.input_schema.required).toEqual([]);
  });
});

describe('createGetRuntimeStateHandler', () => {
  it('returns a JSON snapshot in content', async () => {
    const handler = createGetRuntimeStateHandler(mkSource());
    const result = await handler({ view: 'self' }, new AbortController().signal);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as { self?: { sessionId: string } };
    expect(parsed.self?.sessionId).toBe('sid-1234');
  });

  it('defaults to view=all when no input is supplied', async () => {
    const handler = createGetRuntimeStateHandler(mkSource());
    const result = await handler(undefined, new AbortController().signal);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toHaveProperty('self');
    expect(parsed).toHaveProperty('tools');
    expect(parsed).toHaveProperty('subagents');
  });

  it('defaults to view=all when input is malformed (string)', async () => {
    const handler = createGetRuntimeStateHandler(mkSource());
    const result = await handler('not-an-object', new AbortController().signal);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toHaveProperty('self');
    expect(parsed).toHaveProperty('tools');
    expect(parsed).toHaveProperty('subagents');
  });

  it('coerces unknown view names to "all"', async () => {
    const handler = createGetRuntimeStateHandler(mkSource());
    const result = await handler({ view: 'budget' }, new AbortController().signal);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toHaveProperty('self');
    expect(parsed).toHaveProperty('tools');
    expect(parsed).toHaveProperty('subagents');
  });

  it('view=tools returns only the tools slice', async () => {
    const handler = createGetRuntimeStateHandler(mkSource());
    const result = await handler({ view: 'tools' }, new AbortController().signal);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('self');
    expect(parsed).toHaveProperty('tools');
    expect(parsed).not.toHaveProperty('subagents');
  });

  it('view=subagents returns only the subagents slice', async () => {
    const handler = createGetRuntimeStateHandler(mkSource());
    const result = await handler({ view: 'subagents' }, new AbortController().signal);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('self');
    expect(parsed).not.toHaveProperty('tools');
    expect(parsed).toHaveProperty('subagents');
  });

  it('does not throw on a source whose accessors throw', async () => {
    // Defensive — the handler does NOT catch source errors. This documents
    // current behavior: if a source accessor throws, the handler rejects.
    // SessionToolDispatcher.execute() wraps thrown handler errors as
    // { isError: true } so the model still sees a graceful message.
    const badSource: RuntimeStateSource = {
      getSelf: () => {
        throw new Error('source-failure');
      },
      getTools: () => ({ enabled: [], mcpServers: [] }),
      getSubagents: () => ({ active: [], backgroundJobs: [] }),
      getWorkspace: () => ({ branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null }),
    };
    const handler = createGetRuntimeStateHandler(badSource);
    await expect(
      handler({ view: 'self' }, new AbortController().signal),
    ).rejects.toThrow('source-failure');
  });

  it('respects the supplied AbortSignal type (does not block on aborted signal)', async () => {
    // The handler is fully synchronous internally. Aborted signal does not
    // change its behavior — but the call should still resolve quickly.
    const controller = new AbortController();
    controller.abort();
    const handler = createGetRuntimeStateHandler(mkSource());
    const result = await handler({ view: 'self' }, controller.signal);
    expect(JSON.parse(result.content)).toHaveProperty('self');
  });
});

// --- wrapDispatcherWithRuntimeState ------------------------------------------

/**
 * Regression coverage for the awareness-tool reachability gap on the
 * provider `externalTools` path. Before the wrapper, callers that supplied
 * their own dispatcher (tests, embedders, nesting fixtures) got a working
 * session but `get_runtime_state` silently returned `Unknown tool` because
 * the inner dispatcher never registered the awareness handler. These tests
 * pin the wrapper's two invariants:
 *
 *   1. Intercept: `get_runtime_state` is routed to the awareness handler
 *      WITHOUT touching the inner dispatcher.
 *   2. Delegate: every other tool name passes through verbatim, including
 *      isError / truncated / render fields.
 *
 * Plus the duck-typed `toolDefs` invariant that the openai-compatible
 * provider relies on for OpenAI function-catalog derivation.
 */
describe('wrapDispatcherWithRuntimeState', () => {
  function mkToolCall(name: string, input: unknown = {}): ToolCall {
    return {
      id: 'tc-1',
      name,
      input,
      signal: new AbortController().signal,
    };
  }

  it('intercepts get_runtime_state and routes to the awareness handler', async () => {
    const innerExecute = vi.fn();
    const inner: ToolDispatcher = { execute: innerExecute };
    const wrapped = wrapDispatcherWithRuntimeState(inner, mkSource());

    const result = await wrapped.execute(mkToolCall('get_runtime_state', { view: 'self' }));

    expect(innerExecute).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as { self?: { sessionId: string } };
    expect(parsed.self?.sessionId).toBe('sid-1234');
  });

  it('delegates every other tool name to the inner dispatcher verbatim', async () => {
    const innerResult: ToolResult = { content: 'inner result', isError: true };
    const innerExecute = vi.fn().mockResolvedValue(innerResult);
    const inner: ToolDispatcher = { execute: innerExecute };
    const wrapped = wrapDispatcherWithRuntimeState(inner, mkSource());

    const result = await wrapped.execute(mkToolCall('bash', { command: 'ls' }));

    expect(innerExecute).toHaveBeenCalledTimes(1);
    const passed = innerExecute.mock.calls[0]?.[0] as ToolCall;
    expect(passed?.name).toBe('bash');
    expect(passed?.input).toEqual({ command: 'ls' });
    expect(result).toBe(innerResult); // same object identity — no copy
  });

  it('preserves render hints and truncated/testResult flags through delegation', async () => {
    const innerResult: ToolResult = {
      content: 'output',
      truncated: true,
      render: { diff: { hunks: [] as never[] } as never },
    };
    const inner: ToolDispatcher = { execute: vi.fn().mockResolvedValue(innerResult) };
    const wrapped = wrapDispatcherWithRuntimeState(inner, mkSource());

    const result = await wrapped.execute(mkToolCall('write_file'));
    expect(result.truncated).toBe(true);
    expect(result.render).toBeDefined();
  });

  it('inner dispatcher with toolDefs: wrapper exposes inner defs + getRuntimeStateTool', () => {
    const bashSchema: AnthropicToolDef = {
      name: 'bash',
      category: 'shell',
      description: 'run bash',
      concurrencySafe: false,
      input_schema: { type: 'object', properties: {}, required: [] },
    };
    const inner = {
      execute: vi.fn(),
      toolDefs: [bashSchema] as readonly AnthropicToolDef[],
    } as ToolDispatcher & { toolDefs: readonly AnthropicToolDef[] };
    const wrapped = wrapDispatcherWithRuntimeState(inner, mkSource()) as ToolDispatcher & {
      toolDefs?: readonly AnthropicToolDef[];
    };
    expect(wrapped.toolDefs).toBeDefined();
    expect(wrapped.toolDefs!.map((t) => t.name)).toEqual(['bash', 'get_runtime_state']);
  });

  it('inner dispatcher without toolDefs: wrapper omits the property entirely', () => {
    // Minimal external dispatcher (the common test fixture shape) — wrapper
    // must not synthesise a toolDefs list because the openai-compatible
    // provider's duck-typed read would then misreport the OpenAI catalog
    // as containing only get_runtime_state when no other tools were wired.
    const inner: ToolDispatcher = { execute: vi.fn() };
    const wrapped = wrapDispatcherWithRuntimeState(inner, mkSource()) as ToolDispatcher & {
      toolDefs?: readonly AnthropicToolDef[];
    };
    expect(wrapped.toolDefs).toBeUndefined();
  });

  it('does not duplicate get_runtime_state when inner toolDefs already lists it', () => {
    const inner = {
      execute: vi.fn(),
      toolDefs: [getRuntimeStateTool] as readonly AnthropicToolDef[],
    } as ToolDispatcher & { toolDefs: readonly AnthropicToolDef[] };
    const wrapped = wrapDispatcherWithRuntimeState(inner, mkSource()) as ToolDispatcher & {
      toolDefs?: readonly AnthropicToolDef[];
    };
    expect(wrapped.toolDefs).toBeDefined();
    expect(wrapped.toolDefs!.filter((t) => t.name === 'get_runtime_state').length).toBe(1);
  });

  it('inner throwing on an unrelated tool propagates the rejection (no swallow)', async () => {
    const inner: ToolDispatcher = {
      execute: vi.fn().mockRejectedValue(new Error('inner-bad')),
    };
    const wrapped = wrapDispatcherWithRuntimeState(inner, mkSource());
    await expect(wrapped.execute(mkToolCall('bash'))).rejects.toThrow('inner-bad');
  });
});
