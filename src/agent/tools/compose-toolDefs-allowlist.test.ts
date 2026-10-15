/**
 * Tests for issue #3580: compose node toolDefs must not advertise tools that
 * the named-agent allowlist blocks.
 *
 * Before the fix, `buildComposeNodeProvider` always set
 * `permissions.allowedTools = [...CHILD_ALLOWED_TOOLS]` regardless of the
 * `canUseTool` callback, so the dispatcher's `toolDefs` getter — which filters
 * only by `checkToolPermission` (a static permissions check) — leaked the full
 * CHILD_ALLOWED_TOOLS surface into the model's per-turn tool schemas and into
 * the 'Available tools:' hint in the 'Unknown tool' error message.
 *
 * After the fix, `buildComposeNodeProvider` intersects `permissions.allowedTools`
 * with the named agent's `namedAgentAllowedTools` list, so `toolDefs` only
 * contains tools the node is actually allowed to call.
 *
 * Covers:
 *   1. `bash` is absent from `toolDefs` for a research-agent compose node
 *      (bash is in CHILD_ALLOWED_TOOLS but not in research-agent's allowlist).
 *   2. `read_file` IS present in `toolDefs` (it's in both).
 *   3. The `unknownToolMessage` 'Available tools:' list does not mention `bash`.
 *   4. `canUseTool` enforcement is unchanged (bash call still returns isError).
 *   5. Unnamed node regression: full CHILD_ALLOWED_TOOLS surface preserved.
 *   6. Both provider families (anthropic-direct, openai-compatible).
 *   7. `namedAgentAllowedTools` is set on `ResolvedComposeAgent` iff
 *      `canUseTool` is set (invariant from compose-agent-resolve.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ModelProvider } from '../provider.js';
import type { SessionToolDispatcher } from './dispatcher.js';
import type { ToolCall } from './types.js';

vi.mock('../subagent.js', () => ({
  SubagentManager: vi.fn(function () {
    return { forkSubagent: vi.fn(), teardownAll: vi.fn(async () => {}), kill: vi.fn(async () => true) };
  }),
}));

const mockRunSubagentDAG = vi.fn();
vi.mock('../dag-subagent.js', () => ({
  runSubagentDAG: (...args: unknown[]) => mockRunSubagentDAG(...args),
}));

vi.mock('../routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn(async () => {}),
}));

import { ComposeExecutor, type ComposeExecutorContext } from './compose-executor.js';
import { builtinAgents } from '../agents/builtins.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';
import { CHILD_ALLOWED_TOOLS } from './nesting.js';
import { resolveComposeNodeAgent } from './compose-agent-resolve.js';
import { unknownToolMessage } from './dispatcher.core-exec.js';

const agentRegistry = builtinAgents();

let tmp: string;
let origAfkHome: string | undefined;
const openStores: WorkspaceStore[] = [];
const openProviders: ModelProvider[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
  tmp = mkdtempSync(join(tmpdir(), 'afk-toolDefs-allowlist-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
});

afterEach(() => {
  for (const provider of openProviders.splice(0)) {
    try { provider.close(); } catch { /* ignore */ }
  }
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* ignore */ }
  }
  if (origAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = origAfkHome;
  rmSync(tmp, { recursive: true, force: true });
});

function makeContext(workspaceStore: WorkspaceStore | undefined): ComposeExecutorContext {
  return {
    parentSession: { sessionId: 'parent-session', abortSignal: new AbortController().signal },
    apiKey: 'test-key',
    systemPrompt: 'base prompt',
    agentRegistry,
    defaultSubagentModel: 'inherit',
    resolveApiKeyForModel: () => 'test-key',
    ...(workspaceStore !== undefined ? { workspaceStore } : {}),
  };
}

/** Run one compose node through the real executor; return the node's provider. */
async function nodeProvider(
  node: Record<string, unknown>,
  workspace: 'store' | 'disabled' = 'store',
): Promise<ModelProvider | undefined> {
  const store = workspace === 'store' ? new WorkspaceStore() : undefined;
  if (store !== undefined) openStores.push(store);
  const executor = new ComposeExecutor(makeContext(store));
  await executor.execute({
    id: 'compose-call',
    name: 'compose',
    input: { nodes: [{ id: 'a', prompt: 'do the task', ...node }] },
    signal: new AbortController().signal,
  });
  expect(mockRunSubagentDAG).toHaveBeenCalledTimes(1);
  const dagOpts = mockRunSubagentDAG.mock.calls[0]?.[0] as { nodes: Array<{ provider?: ModelProvider }> };
  const provider = dagOpts.nodes[0]?.provider;
  if (provider !== undefined) openProviders.push(provider);
  return provider;
}

function childDispatcher(provider: ModelProvider): SessionToolDispatcher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (provider as any).buildDispatcher('default', {
    cwd: tmp,
    readRoots: [tmp],
    writeRoots: [tmp],
    sessionId: 'parent-session',
    parentSessionId: 'parent-session',
    subagentId: 'compose-a-1',
  }) as SessionToolDispatcher;
}

function call(name: string): ToolCall {
  return { id: `${name}-1`, name, input: { command: 'echo hi' }, signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// Provider-parametrised matrix
// ---------------------------------------------------------------------------

const MODELS = [
  ['anthropic-direct', 'sonnet'],
  ['openai-compatible', 'gpt-4o'],
] as const;

describe.each(MODELS)('toolDefs allowlist — %s (#3580)', (providerName, model) => {
  it('research-agent: bash is absent from toolDefs (was leaking before fix)', async () => {
    const provider = await nodeProvider({ agent_type: 'research-agent', model });
    expect(provider?.name).toBe(providerName);
    const dispatcher = childDispatcher(provider!);
    const names = dispatcher.toolDefs.map((s) => s.name);
    expect(names, 'bash must NOT appear in research-agent toolDefs').not.toContain('bash');
  });

  it('research-agent: read_file IS in toolDefs (allowed tool not spuriously stripped)', async () => {
    const provider = await nodeProvider({ agent_type: 'research-agent', model });
    const dispatcher = childDispatcher(provider!);
    const names = dispatcher.toolDefs.map((s) => s.name);
    expect(names, 'read_file must appear in research-agent toolDefs').toContain('read_file');
  });

  it('research-agent: write_file is absent from toolDefs', async () => {
    const provider = await nodeProvider({ agent_type: 'research-agent', model });
    const dispatcher = childDispatcher(provider!);
    const names = dispatcher.toolDefs.map((s) => s.name);
    expect(names, 'write_file must NOT appear in research-agent toolDefs').not.toContain('write_file');
  });

  it('research-agent: unknownToolMessage does not list bash in Available tools', async () => {
    const provider = await nodeProvider({ agent_type: 'research-agent', model });
    const dispatcher = childDispatcher(provider!);
    // Build a minimal CoreExecDeps using the dispatcher's own toolDefs
    const msg = unknownToolMessage('nonexistent_tool', {
      handlers: new Map(),
      toolDefs: dispatcher.toolDefs,
      // remaining fields unused by unknownToolMessage
      hookRegistry: undefined,
      sessionId: undefined,
      parentSessionId: undefined,
      rootSessionId: undefined,
      sessionGrantManager: undefined,
      traceWriter: undefined,
      maxOutputBytes: undefined,
      subagentExecutor: undefined,
      skillExecutor: undefined,
      composeExecutor: undefined,
      callHandlerContext: () => { throw new Error('not used'); },
      gateDeps: () => { throw new Error('not used'); },
      tmpdirScope: undefined,
    });
    expect(msg).toContain('Available tools:');
    expect(msg, 'bash must not appear in the Unknown tool suggestion list').not.toContain('bash');
    expect(msg, 'read_file should appear in the suggestion list').toContain('read_file');
  });

  it('research-agent: bash call is still denied at execution time (enforcement unchanged)', async () => {
    const provider = await nodeProvider({ agent_type: 'research-agent', model });
    const dispatcher = childDispatcher(provider!);
    const result = await dispatcher.execute(call('bash'));
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/bash/i);
  });

  it('unnamed node: bash IS in toolDefs (full surface preserved — no regression)', async () => {
    const provider = await nodeProvider({ model });
    // Unnamed nodes have no provider when workspace is disabled; with store they get one.
    if (provider === undefined) return; // workspace-disabled path — skip
    const dispatcher = childDispatcher(provider);
    const names = dispatcher.toolDefs.map((s) => s.name);
    expect(names, 'bash must appear in unnamed node toolDefs (no spurious restriction)').toContain('bash');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
  });

  it('unnamed node: executor-backed agent/skill are NOT advertised (compose leaf, #3579)', async () => {
    const provider = await nodeProvider({ model });
    expect(provider, 'store-backed unnamed node must get a compose node provider').toBeDefined();
    const names = childDispatcher(provider!).toolDefs.map((s) => s.name);
    expect(names).not.toContain('agent');
    expect(names).not.toContain('skill');
    expect(names).toContain('bash');
  });

  it('named research-agent node: agent is NOT advertised although its definition declares it (#3579)', async () => {
    const provider = await nodeProvider({ model, agent_type: 'research-agent' });
    expect(provider).toBeDefined();
    const names = childDispatcher(provider!).toolDefs.map((s) => s.name);
    expect(names).not.toContain('agent');
    expect(names).toContain('read_file');
  });

  it('unnamed node: core write tools appear in toolDefs (no spurious shrinkage)', async () => {
    const provider = await nodeProvider({ model });
    if (provider === undefined) return;
    const dispatcher = childDispatcher(provider);
    const names = dispatcher.toolDefs.map((s) => s.name);
    // Spot-check that key CHILD_ALLOWED_TOOLS members are NOT stripped from
    // unnamed nodes — the fix must only narrow named-agent nodes.
    for (const tool of ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory']) {
      expect(names, `${tool} should be in unnamed node toolDefs`).toContain(tool);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: resolveComposeNodeAgent invariant
// ---------------------------------------------------------------------------

describe('resolveComposeNodeAgent — namedAgentAllowedTools invariant', () => {
  it('sets namedAgentAllowedTools iff canUseTool is set (research-agent)', () => {
    const result = resolveComposeNodeAgent('research-agent', agentRegistry);
    expect(result.canUseTool, 'research-agent should have canUseTool').toBeDefined();
    expect(result.namedAgentAllowedTools, 'namedAgentAllowedTools must be set when canUseTool is set').toBeDefined();
    expect(Array.isArray(result.namedAgentAllowedTools)).toBe(true);
    expect(result.namedAgentAllowedTools!.length).toBeGreaterThan(0);
  });

  it('namedAgentAllowedTools does not include bash for research-agent', () => {
    const result = resolveComposeNodeAgent('research-agent', agentRegistry);
    expect(result.namedAgentAllowedTools).toBeDefined();
    expect(result.namedAgentAllowedTools).not.toContain('bash');
  });

  it('namedAgentAllowedTools includes read_file for research-agent', () => {
    const result = resolveComposeNodeAgent('research-agent', agentRegistry);
    expect(result.namedAgentAllowedTools).toContain('read_file');
  });

  it('returns empty object (no canUseTool, no namedAgentAllowedTools) for undefined agent_type', () => {
    const result = resolveComposeNodeAgent(undefined, agentRegistry);
    expect(result.canUseTool).toBeUndefined();
    expect(result.namedAgentAllowedTools).toBeUndefined();
  });

  it('git-investigator: both canUseTool and namedAgentAllowedTools are set', () => {
    const result = resolveComposeNodeAgent('git-investigator', agentRegistry);
    expect(result.canUseTool).toBeDefined();
    expect(result.namedAgentAllowedTools).toBeDefined();
    expect(result.namedAgentAllowedTools).not.toContain('write_file');
  });
});
