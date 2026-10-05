/**
 * Gate liveness: the DAG node -> forkSubagent hop in `runSubagentDAG`.
 *
 * Contract: a compose node's `canUseTool` (the named-agent tool allowlist
 * built by compose-agent-resolve.ts, regression guard for #2000) must reach
 * the forked child's config, and the fork config must never carry a
 * `permissionMode` (children resolve to 'default'; they never inherit a
 * parent's bypass). Both are optional/absent fields, so a dropped spread or
 * an added field fails silently at runtime: an absent `canUseTool` is
 * allow-all in the dispatcher. compose-gate-liveness.test.ts covers the
 * compose-executor -> node hop with runSubagentDAG mocked; this file covers
 * the next hop with the real runSubagentDAG and a fake manager.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SubagentManager } from './subagent.js';
import type { IAgentSession, Message } from './types.js';
import type { CanUseTool } from './types/sdk-types.js';

vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { runSubagentDAG, type SubagentDAGNode } from './dag-subagent.js';

function makeHandle() {
  return {
    runToResult: vi.fn(async () => ({
      id: 'fake',
      status: 'succeeded',
      message: { role: 'assistant' as const, content: 'ok', timestamp: new Date() } as Message,
    })),
    teardown: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
}

function makeParent(): Pick<IAgentSession, 'sessionId' | 'abortSignal'> {
  return { sessionId: 'gate-liveness-parent', abortSignal: new AbortController().signal };
}

async function forkConfigFor(node: SubagentDAGNode): Promise<Record<string, unknown>> {
  const forkSubagent = vi.fn(async () => makeHandle());
  const manager = { forkSubagent } as unknown as SubagentManager;
  const result = await runSubagentDAG({ manager, parentSession: makeParent(), nodes: [node], edges: [] });
  expect(result.failed).toHaveLength(0);
  expect(forkSubagent).toHaveBeenCalledTimes(1);
  const call = forkSubagent.mock.calls[0] as unknown as [{ config: Record<string, unknown> }];
  return call[0].config;
}

describe('runSubagentDAG gate liveness: node -> fork config', () => {
  it('threads the node canUseTool into the forked child config unchanged', async () => {
    const canUseTool = vi.fn(async () => ({ behavior: 'deny', message: 'not allowed' })) as unknown as CanUseTool;
    const config = await forkConfigFor({
      id: 'restricted',
      systemPrompt: 'read-only agent',
      promptBuilder: () => 'task',
      canUseTool,
    });
    expect(config['canUseTool'], 'named-agent allowlist must reach the fork config').toBe(canUseTool);
  });

  it('leaves canUseTool absent for unrestricted nodes', async () => {
    const config = await forkConfigFor({ id: 'open', systemPrompt: 'worker', promptBuilder: () => 'task' });
    expect(config).not.toHaveProperty('canUseTool');
  });

  it('never sets permissionMode on the forked child config', async () => {
    const config = await forkConfigFor({ id: 'any', systemPrompt: 'worker', promptBuilder: () => 'task' });
    expect(config).not.toHaveProperty('permissionMode');
  });
});
