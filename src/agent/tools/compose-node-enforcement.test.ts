/**
 * Behavioral enforcement tests for compose DAG nodes with a named `agent_type`.
 *
 * Unlike `compose-gate-liveness.test.ts` (which proves the `canUseTool`
 * callback is ATTACHED to the DAG node), these tests drive the node's REAL
 * provider — the one `ComposeExecutor` builds via `resolveComposeNodeProvider`
 * → `buildComposeNodeProvider` — and execute tool calls through the
 * dispatcher that provider constructs for the child session. That is the
 * enforcement point: `provider-lifecycle.ts` calls a preset `config.provider`
 * directly, and both providers read `canUseTool` / `readOnlyBash` only from
 * their constructor options, so a restriction that never reaches the
 * constructor fails open no matter what sits on the fork config.
 *
 * Covered for both provider families (Anthropic-direct and OpenAI-compatible):
 *   - research-agent node: write_file is rejected, nothing is written.
 *   - git-investigator node: mutating bash is rejected, nothing is created;
 *     write_file is rejected (not in its allowlist).
 *   - unnamed node: write_file still succeeds (no regression; proves the
 *     denials above come from the named-agent gate, not path containment).
 *   - AFK_WORKSPACE_DISABLED fallback (no WorkspaceStore): restricted named
 *     nodes still get a restricted provider (canUseTool + readOnlyBash).
 *   - Child dispatchers reject the top-level-only peer tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolCall, ToolResult } from './types.js';
import type { ModelProvider } from '../provider.js';
import type { SessionToolDispatcher } from './dispatcher.js';

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

// Static imports BEFORE beforeEach redirects AFK_HOME (handler graph opens
// cached SQLite handles at import time — see handlers/peer.test.ts).
import { ComposeExecutor, type ComposeExecutorContext } from './compose-executor.js';
import { builtinAgents } from '../agents/builtins.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';

const agentRegistry = builtinAgents();

let tmp: string;
let origAfkHome: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
  tmp = mkdtempSync(join(tmpdir(), 'afk-compose-enforce-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
});

afterEach(() => {
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
  const executor = new ComposeExecutor(makeContext(workspace === 'store' ? new WorkspaceStore() : undefined));
  await executor.execute({
    id: 'compose-call',
    name: 'compose',
    input: { nodes: [{ id: 'a', prompt: 'do the task', ...node }] },
    signal: new AbortController().signal,
  });
  expect(mockRunSubagentDAG).toHaveBeenCalledTimes(1);
  const dagOpts = mockRunSubagentDAG.mock.calls[0]?.[0] as { nodes: Array<{ provider?: ModelProvider }> };
  return dagOpts.nodes[0]?.provider;
}

/** Build the per-query dispatcher a forked child session would get. */
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

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `${name}-1`, name, input, signal: new AbortController().signal };
}

async function run(provider: ModelProvider, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return childDispatcher(provider).execute(call(name, input));
}

const MODELS = [
  ['anthropic-direct', 'sonnet'],
  ['openai-compatible', 'gpt-4o'],
] as const;

describe.each(MODELS)('compose node enforcement — %s', (providerName, model) => {
  it('research-agent node rejects write_file at execution time', async () => {
    const provider = await nodeProvider({ agent_type: 'research-agent', model });
    expect(provider?.name).toBe(providerName);
    const target = join(tmp, 'research-wrote.txt');
    const r = await run(provider!, 'write_file', { file_path: target, content: 'x' });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain('write_file');
    expect(existsSync(target)).toBe(false);
  });

  it('git-investigator node blocks mutating bash and rejects write_file', async () => {
    const provider = await nodeProvider({ agent_type: 'git-investigator', model });
    expect(provider?.name).toBe(providerName);
    const touched = join(tmp, 'git-investigator-touched');
    const bash = await run(provider!, 'bash', { command: `touch ${touched}` });
    expect(bash.isError).toBe(true);
    expect(String(bash.content)).toContain('read-only');
    expect(existsSync(touched)).toBe(false);

    const target = join(tmp, 'gi-wrote.txt');
    const w = await run(provider!, 'write_file', { file_path: target, content: 'x' });
    expect(w.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('unnamed node keeps the full child surface (write_file succeeds)', async () => {
    const provider = await nodeProvider({ model });
    const target = join(tmp, 'unnamed-wrote.txt');
    const r = await run(provider!, 'write_file', { file_path: target, content: 'x' });
    expect(r.isError).toBeFalsy();
    expect(existsSync(target)).toBe(true);
  });

  it('AFK_WORKSPACE_DISABLED fallback: git-investigator still gets a read-only-bash, allowlisted provider', async () => {
    const provider = await nodeProvider({ agent_type: 'git-investigator', model }, 'disabled');
    expect(provider, 'restricted named node must get a constructed provider even without a WorkspaceStore').toBeDefined();
    expect(provider!.name).toBe(providerName);
    const touched = join(tmp, 'fallback-touched');
    const bash = await run(provider!, 'bash', { command: `touch ${touched}` });
    expect(bash.isError).toBe(true);
    expect(existsSync(touched)).toBe(false);
    const target = join(tmp, 'fallback-wrote.txt');
    const w = await run(provider!, 'write_file', { file_path: target, content: 'x' });
    expect(w.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('AFK_WORKSPACE_DISABLED fallback: unnamed node keeps the legacy no-provider path', async () => {
    const provider = await nodeProvider({ model }, 'disabled');
    expect(provider).toBeUndefined();
  });

  it('child dispatcher rejects list_sessions and send_to_session', async () => {
    const provider = await nodeProvider({ model });
    const list = await run(provider!, 'list_sessions', {});
    expect(list.isError).toBe(true);
    expect(String(list.content)).toContain('top-level');
    const send = await run(provider!, 'send_to_session', { to: 'someone', message: 'hi' });
    expect(send.isError).toBe(true);
    expect(String(send.content)).toContain('top-level');
  });
});
