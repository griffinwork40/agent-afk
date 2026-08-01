/**
 * Characterization tests for `AnthropicDirectProvider.buildDispatcher` (#824).
 *
 * Written BEFORE the index.ts decomposition and required to stay green
 * verbatim afterwards. These pin CURRENT behavior — they are a safety net for
 * an extraction, not an endorsement of every detail they observe.
 *
 * What is pinned here:
 *   - handler-map composition + precedence (builtin > runtime-state > custom > MCP)
 *   - schema list ordering (provider schemas, then MCP, then plan-exit last)
 *   - the read-only-memory handler filter
 *   - `allowAll` derivation from the permission mode
 *   - the allowlist union for MCP + custom tool names
 *   - fork-scoped `maxOutputBytes` arming
 *   - plan-exit registration being gated on `planExitControls`, NOT on mode
 *
 * Observation strategy: `buildDispatcher` is private and returns a
 * `SessionToolDispatcher` whose collaborators are private fields. Tests reach
 * through `as any` — the same idiom already used by
 * `src/agent/tools/custom-tool.test.ts:302,354,365`, which is the only existing
 * caller that drives this method directly. Reaching for the private fields is
 * deliberate: the point is to pin internal WIRING that has no public read-back.
 *
 * @module agent/providers/anthropic-direct/build-dispatcher.characterization.test
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AnthropicDirectProvider } from './index.js';
import { tool } from '../../tools/custom-tool.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/handlers/exit-plan-mode.js';
import type { RuntimeStateSource } from '../../awareness/index.js';
import type { SessionToolDispatcher } from '../../tools/dispatcher.js';
import type { AnthropicToolDef, ToolHandler } from '../../tools/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Call the private `buildDispatcher` the way custom-tool.test.ts does. */
function build(
  provider: AnthropicDirectProvider,
  mode = 'default',
  opts: Record<string, unknown> = {},
): SessionToolDispatcher {
  return (provider as any).buildDispatcher(mode, opts) as SessionToolDispatcher;
}

function handlerNames(d: SessionToolDispatcher): string[] {
  return [...((d as any).handlers as Map<string, ToolHandler>).keys()];
}

function schemaNames(d: SessionToolDispatcher): string[] {
  return ((d as any).schemas as AnthropicToolDef[]).map((s) => s.name);
}

/** Minimal RuntimeStateSource — only identity matters for these assertions. */
function stubSource(enabled: string[] = []): RuntimeStateSource {
  return {
    getSelf: () => ({
      sessionId: null,
      surface: 'cli',
      parentSessionId: null,
      depth: null,
      maxDepth: null,
      phaseRole: null,
      cwd: '/work',
      model: { provider: 'anthropic-direct', name: 'claude-sonnet-5' },
      permissionMode: 'default',
    }),
    getTools: () => ({ enabled, mcpServers: [] }),
    getSubagents: () => ({ active: [], backgroundJobs: [] }),
    getWorkspace: () => ({
      branch: null,
      headSha: null,
      dirty: null,
      dirtyCount: null,
      remoteUrl: null,
    }),
  } as unknown as RuntimeStateSource;
}

describe('buildDispatcher characterization (#824) — handler map', () => {
  it('registers the builtin handlers plus the full memory trio by default', () => {
    const d = build(new AnthropicDirectProvider());
    const names = handlerNames(d);
    expect(names).toContain('bash');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    // Full (non-read-only) session gets all three memory handlers.
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_update');
    expect(names).toContain('procedure_write');
  });

  it('readOnlyMemory keeps memory_search and drops the memory write handlers', () => {
    const d = build(new AnthropicDirectProvider({ readOnlyMemory: true }));
    const names = handlerNames(d);
    expect(names).toContain('memory_search');
    expect(names).not.toContain('memory_update');
    expect(names).not.toContain('procedure_write');
  });

  it('registers get_runtime_state ONLY when a runtimeStateSource is supplied', () => {
    const without = build(new AnthropicDirectProvider());
    expect(handlerNames(without)).not.toContain('get_runtime_state');

    const withSource = build(new AnthropicDirectProvider(), 'default', {
      runtimeStateSource: stubSource(),
    });
    expect(handlerNames(withSource)).toContain('get_runtime_state');
  });

  it('registers a non-colliding custom handler by identity', () => {
    const myTool = tool('char_custom_tool', 'desc', z.object({ q: z.string() }), async () => ({
      content: 'ok',
    }));
    const d = build(new AnthropicDirectProvider({ customTools: [myTool] }));
    expect((d as any).handlers.get('char_custom_tool')).toBe(myTool.handler);
  });

  it('a custom tool colliding with a builtin does NOT win (builtin precedence)', () => {
    const colliding = tool('bash', 'shadow', z.object({ x: z.string() }), async () => ({
      content: 'CUSTOM',
    }));
    const d = build(new AnthropicDirectProvider({ customTools: [colliding] }));
    expect((d as any).handlers.get('bash')).not.toBe(colliding.handler);
  });

  it('a custom tool colliding with get_runtime_state loses to the awareness handler', () => {
    // Pins the ordering: runtime-state is registered BEFORE custom tools, and
    // the custom loop skips names already present.
    const colliding = tool('get_runtime_state', 'shadow', z.object({}), async () => ({
      content: 'CUSTOM',
    }));
    const d = build(new AnthropicDirectProvider({ customTools: [colliding] }), 'default', {
      runtimeStateSource: stubSource(),
    });
    expect((d as any).handlers.get('get_runtime_state')).not.toBe(colliding.handler);
  });
});

describe('buildDispatcher characterization (#824) — schemas', () => {
  it('passes the provider schema list through, with get_runtime_state always present', () => {
    const d = build(new AnthropicDirectProvider());
    const names = schemaNames(d);
    expect(names).toContain('get_runtime_state');
    expect(names).toContain('bash');
    // No plan-exit schema without planExitControls.
    expect(names).not.toContain(EXIT_PLAN_MODE_TOOL_NAME);
  });

  it('appends the plan-exit schema LAST and registers its handler when controls are supplied', () => {
    const controls = { approve: () => {}, keepPlanning: () => {} };
    const d = build(new AnthropicDirectProvider(), 'default', {
      planExitControls: controls as never,
    });
    const names = schemaNames(d);
    expect(names[names.length - 1]).toBe(EXIT_PLAN_MODE_TOOL_NAME);
    expect(handlerNames(d)).toContain(EXIT_PLAN_MODE_TOOL_NAME);
  });

  it('registers plan-exit RESIDENT — gated on controls, NOT on permissionMode', () => {
    // Regression guard for the "enter plan mode AFTER launch" flow: the
    // dispatcher is built once per query and never rebuilt by
    // setPermissionMode, so a mode-gated registration leaves the tool
    // permanently unwired. 'default' mode + controls MUST still register it.
    const controls = { approve: () => {}, keepPlanning: () => {} };
    const inDefault = build(new AnthropicDirectProvider(), 'default', {
      planExitControls: controls as never,
    });
    expect(handlerNames(inDefault)).toContain(EXIT_PLAN_MODE_TOOL_NAME);

    const inPlan = build(new AnthropicDirectProvider(), 'plan', {
      planExitControls: controls as never,
    });
    expect(handlerNames(inPlan)).toContain(EXIT_PLAN_MODE_TOOL_NAME);
  });
});

describe('buildDispatcher characterization (#824) — permissions and options', () => {
  it('derives allowAll from the permission mode (bypassPermissions / autonomous only)', () => {
    expect((build(new AnthropicDirectProvider(), 'default') as any)._allowAll).toBe(false);
    expect((build(new AnthropicDirectProvider(), 'plan') as any)._allowAll).toBe(false);
    expect(
      (build(new AnthropicDirectProvider(), 'bypassPermissions') as any)._allowAll,
    ).toBe(true);
    expect((build(new AnthropicDirectProvider(), 'autonomous') as any)._allowAll).toBe(true);
  });

  it('leaves permissions undefined (allow-all) when no allowlist is configured', () => {
    expect((build(new AnthropicDirectProvider()) as any).permissions).toBeUndefined();
  });

  it('unions custom-tool names into a configured allowlist', () => {
    const myTool = tool('char_allowlisted', 'desc', z.object({ x: z.string() }), async () => ({
      content: '',
    }));
    const d = build(
      new AnthropicDirectProvider({
        customTools: [myTool],
        permissions: { allowedTools: ['bash'] },
      }),
    );
    const allowed: string[] = (d as any).permissions.allowedTools;
    expect(allowed).toContain('char_allowlisted');
    expect(allowed).toContain('bash');
  });

  it('arms maxOutputBytes ONLY from subagentToolOutputCapBytes (not parentSessionId)', () => {
    const uncapped = build(new AnthropicDirectProvider(), 'default', {
      parentSessionId: 'parent-123',
    });
    expect((uncapped as any).maxOutputBytes).toBeUndefined();

    const capped = build(new AnthropicDirectProvider(), 'default', {
      subagentToolOutputCapBytes: 4096,
    });
    expect((capped as any).maxOutputBytes).toBe(4096);
  });

  it('threads cwd, shared root arrays BY REFERENCE, and session identity', () => {
    const readRoots = ['/work'];
    const writeRoots = ['/work'];
    const d = build(new AnthropicDirectProvider(), 'default', {
      cwd: '/work',
      readRoots,
      writeRoots,
      sessionId: 'sid-1',
      parentSessionId: 'pid-1',
      subagentId: 'sub-1',
    });
    // By-reference sharing is what makes /allow-dir grants survive across
    // turns — a snapshot copy here would silently break grant propagation.
    expect((d as any)._readRoots).toBe(readRoots);
    expect((d as any)._writeRoots).toBe(writeRoots);
    expect((d as any).sessionId).toBe('sid-1');
    expect((d as any).parentSessionId).toBe('pid-1');
    expect((d as any).subagentId).toBe('sub-1');
  });

  it('forwards readOnlyBash from the provider construction flag', () => {
    expect((build(new AnthropicDirectProvider()) as any).readOnlyBash).toBe(false);
    expect(
      (build(new AnthropicDirectProvider({ readOnlyBash: true })) as any).readOnlyBash,
    ).toBe(true);
  });

  it('passes itself as the session grant manager', () => {
    const provider = new AnthropicDirectProvider();
    expect((build(provider) as any).sessionGrantManager).toBe(provider);
  });
});

describe('buildDispatcher characterization (#824) — MCP merge', () => {
  const mcpTool: AnthropicToolDef = {
    name: 'mcp__srv__do_thing',
    description: 'mcp tool',
    input_schema: { type: 'object', properties: {}, required: [] },
  } as AnthropicToolDef;

  const mcpHandler: ToolHandler = async () => ({ content: 'mcp' });

  function fakeManager(): any {
    return {
      getMcpTools: () => [mcpTool],
      getMcpHandlers: () => new Map<string, ToolHandler>([[mcpTool.name, mcpHandler]]),
      getMcpToolWireNames: () => [mcpTool.name],
      onToolsRefreshed: undefined,
    };
  }

  it('merges MCP handlers and appends MCP schemas AFTER the provider schemas', () => {
    const d = build(new AnthropicDirectProvider({ mcpManager: fakeManager() }));
    expect((d as any).handlers.get(mcpTool.name)).toBe(mcpHandler);

    const names = schemaNames(d);
    expect(names).toContain(mcpTool.name);
    // Builtins precede MCP entries so builtin names win any overlap.
    expect(names.indexOf('bash')).toBeLessThan(names.indexOf(mcpTool.name));
  });

  it('unions MCP wire names into a configured allowlist', () => {
    const d = build(
      new AnthropicDirectProvider({
        mcpManager: fakeManager(),
        permissions: { allowedTools: ['bash'] },
      }),
    );
    const allowed: string[] = (d as any).permissions.allowedTools;
    expect(allowed).toContain(mcpTool.name);
    expect(allowed).toContain('bash');
  });

  it('caches MCP tools/handlers across builds and invalidates on onToolsRefreshed', () => {
    let toolCalls = 0;
    let handlerCalls = 0;
    const mgr: any = {
      getMcpTools: () => {
        toolCalls += 1;
        return [mcpTool];
      },
      getMcpHandlers: () => {
        handlerCalls += 1;
        return new Map<string, ToolHandler>([[mcpTool.name, mcpHandler]]);
      },
      getMcpToolWireNames: () => [mcpTool.name],
      onToolsRefreshed: undefined,
    };
    const provider = new AnthropicDirectProvider({ mcpManager: mgr });

    build(provider);
    expect(toolCalls).toBe(1);
    expect(handlerCalls).toBe(1);

    // Second build serves from cache — no re-fetch.
    build(provider);
    expect(toolCalls).toBe(1);
    expect(handlerCalls).toBe(1);

    // The constructor chained an invalidating callback onto the manager.
    mgr.onToolsRefreshed('srv');
    build(provider);
    expect(toolCalls).toBe(2);
    expect(handlerCalls).toBe(2);
  });

  it('propagates a nullish handler map instead of silently registering nothing', () => {
    // The original iterated `this._mcpHandlersCache` directly, so a manager
    // returning a nullish map threw. Pinned because the obvious "hardening"
    // (`?? []`) converts a loud failure into a silent zero-handler dispatcher
    // — the model would just quietly lose every MCP tool.
    const mgr: any = {
      getMcpTools: () => [mcpTool],
      getMcpHandlers: () => null,
      getMcpToolWireNames: () => [mcpTool.name],
      onToolsRefreshed: undefined,
    };
    expect(() => build(new AnthropicDirectProvider({ mcpManager: mgr }))).toThrow();
  });

  it('chains through a pre-existing onToolsRefreshed observer', () => {
    let seen: string | undefined;
    const mgr: any = {
      getMcpTools: () => [],
      getMcpHandlers: () => new Map(),
      getMcpToolWireNames: () => [],
      onToolsRefreshed: (name: string) => {
        seen = name;
      },
    };
    // eslint-disable-next-line no-new
    new AnthropicDirectProvider({ mcpManager: mgr });
    mgr.onToolsRefreshed('srv-x');
    expect(seen).toBe('srv-x');
  });
});
