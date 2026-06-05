/**
 * Verifies that MCP-bridged tools fire PreToolUse and PostToolUse hooks
 * via the standard `SessionToolDispatcher` handler-lookup path. This is a
 * load-bearing claim from the PR-1 research brief: MCP tools should
 * inherit hook behaviour for free because they're registered through
 * `handlers.set()` like any other tool.
 *
 * Strategy: register a real MCP-bridged handler from `McpManager` plus the
 * required schema, then drive `dispatcher.execute()` and assert the hook
 * registry observed both events.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { SessionToolDispatcher } from '../tools/dispatcher.js';
import { createHookRegistryImpl } from '../hook-registry.js';
import { McpManager } from './manager.js';
import type { ToolCall } from '../tools/types.js';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE = resolve(dirname(__filename), '__fixtures__/test-server.mjs');

let manager: McpManager | undefined;

afterEach(async () => {
  if (manager) {
    await manager.disconnectAll();
    manager = undefined;
  }
});

describe('MCP tool dispatch — hook integration', () => {
  it(
    'fires PreToolUse and PostToolUse for an MCP-bridged tool call',
    async () => {
      manager = await McpManager.fromConfig({
        srv: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
      });

      const handlers = manager.getMcpHandlers();
      const schemas = manager.getMcpTools();

      // PreToolUse + PostToolUse listeners.
      const pre = vi.fn();
      const post = vi.fn();
      const hookRegistry = createHookRegistryImpl();
      hookRegistry.register('PreToolUse', async (ctx) => {
        if (ctx.event === 'PreToolUse') pre(ctx.toolName);
        return {};
      });
      hookRegistry.register('PostToolUse', async (ctx) => {
        if (ctx.event === 'PostToolUse') post(ctx.toolName);
        return {};
      });

      const dispatcher = new SessionToolDispatcher({
        handlers,
        schemas,
        hookRegistry,
        permissions: { allowedTools: [...handlers.keys()] },
      });

      const call: ToolCall = {
        id: 'test-1',
        name: 'mcp__srv__echo',
        input: { text: 'via dispatcher' },
        signal: new AbortController().signal,
      };
      const result = await dispatcher.execute(call);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('via dispatcher');
      expect(pre).toHaveBeenCalledWith('mcp__srv__echo');
      // PostToolUse is fire-and-forget — give the microtask queue a tick.
      await new Promise((r) => setImmediate(r));
      expect(post).toHaveBeenCalledWith('mcp__srv__echo');
    },
    { timeout: 15_000 },
  );

  it(
    'honours a PreToolUse block decision for an MCP tool',
    async () => {
      manager = await McpManager.fromConfig({
        srv: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
        },
      });

      const handlers = manager.getMcpHandlers();
      const schemas = manager.getMcpTools();
      const hookRegistry = createHookRegistryImpl();
      hookRegistry.register('PreToolUse', async (ctx) => {
        if (ctx.event === 'PreToolUse' && ctx.toolName === 'mcp__srv__boom') {
          return { decision: 'block', reason: 'no boom for you' };
        }
        return {};
      });

      const dispatcher = new SessionToolDispatcher({
        handlers,
        schemas,
        hookRegistry,
        permissions: { allowedTools: [...handlers.keys()] },
      });

      const result = await dispatcher.execute({
        id: 'test-2',
        name: 'mcp__srv__boom',
        input: {},
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/blocked by PreToolUse/);
      expect(result.content).toMatch(/no boom for you/);
    },
    { timeout: 15_000 },
  );
});
