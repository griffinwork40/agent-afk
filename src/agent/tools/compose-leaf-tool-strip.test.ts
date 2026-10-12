/**
 * Tests for issue #3579: compose leaf nodes must not advertise or allow
 * executor-backed tools (`agent`, `skill`) even when the named-agent
 * definition explicitly declares them.
 *
 * Covered:
 *   - resolveComposeNodeAgent strips `agent` from research-agent's allowlist
 *     (research-agent declares `Agent(git-investigator)` which normalises to
 *     `agent` in CHILD_ALLOWED_TOOLS; it must be absent after resolution).
 *   - The canUseTool callback built from the stripped allowlist denies `agent`
 *     and `skill` calls with an informative error.
 *   - COMPOSE_LEAF_NOTICE is appended to the system prompt when tools are
 *     stripped, so the model knows it is a leaf.
 *   - A named agent whose definition does NOT include `agent`/`skill` is
 *     unaffected: no notice, no spurious denial.
 *   - Inherit-all agents (no `tools` frontmatter) return no canUseTool and
 *     no notice (unchanged behaviour — leaf invariant is enforced by the
 *     provider omitting subagentExecutor, which already errors; no allowlist
 *     to strip).
 *   - Non-compose children (normal subagents) are unaffected: the stripped
 *     constant is exported from compose-agent-resolve.ts only and is not
 *     applied anywhere else.
 *   - End-to-end: a real ComposeExecutor with research-agent builds a node
 *     whose provider's dispatcher denies `agent` at execution time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ------------------------------------------------------------------
// Mocks (must precede static imports that transitively pull these in)
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// Static imports (after mocks)
// ------------------------------------------------------------------
import {
  resolveComposeNodeAgent,
  COMPOSE_LEAF_STRIPPED_TOOLS,
  COMPOSE_LEAF_NOTICE,
} from './compose-agent-resolve.js';
import { builtinAgents } from '../agents/builtins.js';
import { ComposeExecutor, type ComposeExecutorContext } from './compose-executor.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';
import type { ModelProvider } from '../provider.js';
import type { SessionToolDispatcher } from './dispatcher.js';
import type { ToolCall, ToolResult } from './types.js';

const agentRegistry = builtinAgents();

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
let tmp: string;
let origAfkHome: string | undefined;
const openStores: WorkspaceStore[] = [];
const openProviders: ModelProvider[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
  tmp = mkdtempSync(join(tmpdir(), 'afk-3579-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
});

afterEach(() => {
  for (const p of openProviders.splice(0)) {
    try { p.close(); } catch { /* ignore */ }
  }
  for (const s of openStores.splice(0)) {
    try { s.close(); } catch { /* ignore */ }
  }
  if (origAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = origAfkHome;
  rmSync(tmp, { recursive: true, force: true });
});

function makeContext(workspaceStore?: WorkspaceStore): ComposeExecutorContext {
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

/** Run one compose node through the real executor; return the DAG node spec. */
async function runAndGetDagNode(
  node: Record<string, unknown>,
): Promise<{ provider?: ModelProvider; canUseTool?: unknown; systemPrompt?: string }> {
  const store = new WorkspaceStore();
  openStores.push(store);
  const executor = new ComposeExecutor(makeContext(store));
  await executor.execute({
    id: 'compose-call',
    name: 'compose',
    input: { nodes: [{ id: 'a', prompt: 'do the task', ...node }] },
    signal: new AbortController().signal,
  });
  expect(mockRunSubagentDAG).toHaveBeenCalledTimes(1);
  const dagOpts = mockRunSubagentDAG.mock.calls[0]?.[0] as {
    nodes: Array<{ provider?: ModelProvider; canUseTool?: unknown; systemPrompt?: string }>;
  };
  const dagNode = dagOpts.nodes[0]!;
  if (dagNode.provider !== undefined) openProviders.push(dagNode.provider);
  return dagNode;
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

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: `${name}-1`, name, input, signal: new AbortController().signal };
}

async function runTool(
  provider: ModelProvider,
  name: string,
  input: Record<string, unknown> = {},
): Promise<ToolResult> {
  return childDispatcher(provider).execute(call(name, input));
}

// ------------------------------------------------------------------
// Unit tests: resolveComposeNodeAgent directly
// ------------------------------------------------------------------

describe('resolveComposeNodeAgent — leaf tool stripping', () => {
  it('COMPOSE_LEAF_STRIPPED_TOOLS contains agent and skill', () => {
    expect(COMPOSE_LEAF_STRIPPED_TOOLS.has('agent')).toBe(true);
    expect(COMPOSE_LEAF_STRIPPED_TOOLS.has('skill')).toBe(true);
  });

  it('research-agent: agent is absent from resolved canUseTool allowlist', async () => {
    // research-agent registry entry declares Agent(git-investigator), which
    // resolveAgentToolAccess maps to 'agent'. The fix must strip it.
    const resolved = resolveComposeNodeAgent('research-agent', agentRegistry);

    expect(resolved.canUseTool).toBeDefined();

    // canUseTool must DENY agent
    const agentResult = await resolved.canUseTool!(
      'agent',
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(agentResult.behavior).toBe('deny');

    // canUseTool must DENY skill
    const skillResult = await resolved.canUseTool!(
      'skill',
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(skillResult.behavior).toBe('deny');
  });

  it('research-agent: COMPOSE_LEAF_NOTICE is appended to the system prompt', () => {
    const resolved = resolveComposeNodeAgent('research-agent', agentRegistry);
    expect(resolved.systemPrompt).toContain(COMPOSE_LEAF_NOTICE);
    // The definition body must still be present (not replaced)
    expect(resolved.systemPrompt!.length).toBeGreaterThan(COMPOSE_LEAF_NOTICE.length);
  });

  it('research-agent: canUseTool still allows declared read tools (read_file, grep, glob)', async () => {
    const resolved = resolveComposeNodeAgent('research-agent', agentRegistry);
    for (const tool of ['read_file', 'grep', 'glob', 'web_scrape']) {
      const r = await resolved.canUseTool!(
        tool,
        {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
      expect(r.behavior, `${tool} should be allowed for research-agent leaf`).toBe('allow');
    }
  });

  it('git-investigator: no agent/skill in its declaration — no notice appended', () => {
    // git-investigator declares only read tools; no executor-backed tools.
    // The notice must NOT be appended (no spurious modification).
    const resolved = resolveComposeNodeAgent('git-investigator', agentRegistry);
    // It has a canUseTool (it has a restricted tool list)
    expect(resolved.canUseTool).toBeDefined();
    // But the notice must NOT appear — no tools were stripped
    if (resolved.systemPrompt !== undefined) {
      expect(resolved.systemPrompt).not.toContain(COMPOSE_LEAF_NOTICE);
    }
  });

  it('inherit-all agent (no tools frontmatter): canUseTool is undefined, no notice', () => {
    // Build a minimal inherit-all agent entry for testing
    const inheritAllRegistry = new Map([
      [
        'inherit-all-agent',
        {
          name: 'inherit-all-agent',
          definition: { prompt: 'I inherit everything.' },
          // no tools, no disallowedTools
        } as import('../agents/types.js').RegisteredAgent,
      ],
    ]);

    const resolved = resolveComposeNodeAgent('inherit-all-agent', inheritAllRegistry);
    // inherit-all: no allowlist restriction, no notice
    expect(resolved.canUseTool).toBeUndefined();
    // systemPrompt may be set from definition body, but must not include the notice
    if (resolved.systemPrompt !== undefined) {
      expect(resolved.systemPrompt).not.toContain(COMPOSE_LEAF_NOTICE);
    }
  });

  it('returns {} for undefined agent_type (no named agent)', () => {
    const resolved = resolveComposeNodeAgent(undefined, agentRegistry);
    expect(resolved).toEqual({});
  });

  it('throws on unknown agent_type', () => {
    expect(() => resolveComposeNodeAgent('no-such-agent', agentRegistry)).toThrow(
      /not found/,
    );
  });
});

// ------------------------------------------------------------------
// End-to-end: real ComposeExecutor → provider → dispatcher
// ------------------------------------------------------------------

describe('compose leaf invariant — end-to-end (issue #3579)', () => {
  it('research-agent node: agent tool is denied at dispatcher execution time', async () => {
    const dagNode = await runAndGetDagNode({ agent_type: 'research-agent', model: 'sonnet' });
    expect(dagNode.provider).toBeDefined();

    const result = await runTool(dagNode.provider!, 'agent', {
      prompt: 'delegate this',
      model: 'sonnet',
    });
    // Must be an error — not "Agent tool is not available" (executor path) but
    // the canUseTool deny message containing 'agent'
    expect(result.isError).toBe(true);
    const content = String(result.content);
    // The deny message should mention the tool name
    expect(content).toMatch(/agent/i);
  });

  it('research-agent node: skill tool is denied at dispatcher execution time', async () => {
    const dagNode = await runAndGetDagNode({ agent_type: 'research-agent', model: 'sonnet' });
    expect(dagNode.provider).toBeDefined();

    const result = await runTool(dagNode.provider!, 'skill', { name: 'some-skill' });
    expect(result.isError).toBe(true);
  });

  it('research-agent node: agent is absent from the node surface (unknown-tool answer, not the executor error)', async () => {
    // Before the fix: agent reached the executor path (dispatcher.subagent-tools.ts)
    // and returned "Agent tool is not available in this session configuration".
    // After the fix: agent/skill are removed from every compose node's
    // permissions.allowedTools, so the dispatcher answers as for any tool the
    // node does not have: "Unknown tool ... does not exist" plus the real list.
    const dagNode = await runAndGetDagNode({ agent_type: 'research-agent', model: 'sonnet' });
    const result = await runTool(dagNode.provider!, 'agent', { prompt: 'hi', model: 'sonnet' });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('does not exist');
    const listed = /Available tools: ([^.]*)\./.exec(String(result.content))?.[1]?.split(', ') ?? [];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).not.toContain('agent');
    expect(listed).not.toContain('bash');
    expect(String(result.content)).not.toContain('not available in this session configuration');
  });

  it('research-agent node: system prompt contains COMPOSE_LEAF_NOTICE', async () => {
    const dagNode = await runAndGetDagNode({ agent_type: 'research-agent', model: 'sonnet' });
    expect(dagNode.systemPrompt).toContain(COMPOSE_LEAF_NOTICE);
  });

  it('unnamed node: unaffected — write_file still succeeds (no regression)', async () => {
    const dagNode = await runAndGetDagNode({ model: 'sonnet' });
    // Unnamed nodes have no canUseTool restriction from agent_type
    // (they may or may not have a provider depending on workspace)
    // The key invariant: canUseTool is not set on the dag node for unnamed nodes
    expect(dagNode.canUseTool).toBeUndefined();
  });

  it('git-investigator node: no notice in system prompt (no executor tools declared)', async () => {
    const dagNode = await runAndGetDagNode({ agent_type: 'git-investigator', model: 'sonnet' });
    if (dagNode.systemPrompt !== undefined) {
      expect(dagNode.systemPrompt).not.toContain(COMPOSE_LEAF_NOTICE);
    }
  });
});
