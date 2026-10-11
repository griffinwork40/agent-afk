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
import { XaiProvider } from '../providers/xai/index.js';

const agentRegistry = builtinAgents();

let tmp: string;
let origAfkHome: string | undefined;
/**
 * Tracks all WorkspaceStore instances created by the current test so afterEach
 * can close them before rmSync. Required on Windows: better-sqlite3 holds an
 * open file handle on the WAL-mode database, and rmSync throws EBUSY while
 * the handle remains open. Closing explicitly avoids this even when the test
 * itself throws (afterEach always runs).
 */
const openStores: WorkspaceStore[] = [];
/**
 * Tracks ModelProvider instances built internally by ComposeExecutor /
 * buildComposeNodeProvider. Each provider lazily opens its own StateStore
 * (better-sqlite3 handle on state/kv/kv.db) when `buildDispatcher` is first
 * called. On Windows these handles block rmSync with EBUSY unless explicitly
 * closed. `openStores` only covers WorkspaceStores the test creates directly;
 * this array covers the providers the executor creates internally.
 */
const openProviders: ModelProvider[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
  tmp = mkdtempSync(join(tmpdir(), 'afk-compose-enforce-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
});

afterEach(() => {
  // Close all provider and WorkspaceStore handles opened during this test
  // before removing the temp directory. On Windows, better-sqlite3 WAL-mode
  // handles stay open until explicitly closed, causing rmSync to throw EBUSY.
  // Providers first: their close() releases the internal StateStore /
  // MemoryStore / WorkspaceStore they lazily opened via buildDispatcher.
  for (const provider of openProviders.splice(0)) {
    try { provider.close(); } catch { /* ignore: provider may already be closed */ }
  }
  for (const store of openStores.splice(0)) {
    try { store.close(); } catch { /* ignore: store may already be closed */ }
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

// xai is intentionally omitted from this provider-parametrised matrix.
// XaiProvider wraps OpenAICompatibleProvider for the Chat Completions wire path
// but does not expose buildDispatcher directly (it delegates to an inner
// OpenAICompatibleProvider). Restriction enforcement is therefore already
// exercised by the openai-compatible row above. A separate focused test below
// proves that buildComposeNodeProvider routes grok-* models to XaiProvider
// (not AnthropicDirectProvider) — the correctness bug identified in PR #3270
// review discussion r4213677334.
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

/**
 * Regression for PR #3270 reviewer finding (discussion r4213677334):
 * `buildComposeNodeProvider` previously branched only on `openai-compatible`
 * and fell through to `AnthropicDirectProvider` for all other routes —
 * including `xai`. A Grok node (`grok-3`, `grok-2`, …) would silently POST
 * to api.anthropic.com, bypassing xAI auth and receiving a 404/400.
 *
 * This suite proves `grok-*` models route to `XaiProvider` (name === 'xai'),
 * that named-agent restrictions (canUseTool, readOnlyBash) are threaded into
 * XaiProvider's inner OpenAICompatibleProvider, and that the inner dispatcher
 * actually enforces those restrictions at execution time.
 *
 * XaiProvider does not expose `buildDispatcher` directly — it delegates to
 * `this.inner` (an `OpenAICompatibleProvider`). `inner` and `buildDispatcher`
 * are both private but runtime-accessible via an `any` cast, which is the same
 * technique the `childDispatcher` helper above already uses.
 */

/**
 * Build the per-query dispatcher through XaiProvider's typed test accessor
 * (`_innerForTesting`) so restriction enforcement is exercised end-to-end
 * without unsafe `as any` casts.
 */
function xaiChildDispatcher(provider: ModelProvider): SessionToolDispatcher {
  if (!(provider instanceof XaiProvider)) {
    throw new Error(`Expected XaiProvider but got ${provider.name} — structure has changed`);
  }
  const inner = provider._innerForTesting;
  // `buildDispatcher` is private on OpenAICompatibleProvider; reach it via
  // the same pattern as the Anthropic-direct `childDispatcher` helper above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (inner as any).buildDispatcher('default', {
    cwd: tmp,
    readRoots: [tmp],
    writeRoots: [tmp],
    sessionId: 'parent-session',
    parentSessionId: 'parent-session',
    subagentId: 'compose-a-1',
  }) as SessionToolDispatcher;
}

async function runXai(provider: ModelProvider, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  return xaiChildDispatcher(provider).execute(call(name, input));
}

describe('compose node enforcement — xai routing regression (PR #3270 r4213677334)', () => {
  it('grok-* model routes to XaiProvider, not AnthropicDirectProvider', async () => {
    const provider = await nodeProvider({ model: 'grok-3' });
    expect(provider?.name, 'grok-3 must route to XaiProvider (name=xai), not anthropic-direct').toBe(
      'xai',
    );
  });

  it('grok-2 also routes to XaiProvider (not only grok-3)', async () => {
    const provider = await nodeProvider({ model: 'grok-2' });
    expect(provider?.name).toBe('xai');
  });

  it('grok-* research-agent node: write_file is rejected at execution time (canUseTool wired into inner)', async () => {
    const provider = await nodeProvider({ agent_type: 'research-agent', model: 'grok-3' });
    expect(provider?.name).toBe('xai');
    const target = join(tmp, 'xai-research-wrote.txt');
    const r = await runXai(provider!, 'write_file', { file_path: target, content: 'x' });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain('write_file');
    expect(existsSync(target)).toBe(false);
  });

  it('grok-* git-investigator node: mutating bash and write_file are both rejected (readOnlyBash + canUseTool wired into inner)', async () => {
    const provider = await nodeProvider({ agent_type: 'git-investigator', model: 'grok-3' });
    expect(provider?.name).toBe('xai');

    const touched = join(tmp, 'xai-gi-touched');
    const bash = await runXai(provider!, 'bash', { command: `touch ${touched}` });
    expect(bash.isError).toBe(true);
    expect(String(bash.content)).toContain('read-only');
    expect(existsSync(touched)).toBe(false);

    const target = join(tmp, 'xai-gi-wrote.txt');
    const w = await runXai(provider!, 'write_file', { file_path: target, content: 'x' });
    expect(w.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it('grok-* unnamed node: write_file succeeds (no spurious restrictions on the Grok path)', async () => {
    const provider = await nodeProvider({ model: 'grok-3' });
    expect(provider?.name).toBe('xai');
    const target = join(tmp, 'xai-unnamed-wrote.txt');
    const r = await runXai(provider!, 'write_file', { file_path: target, content: 'x' });
    expect(r.isError).toBeFalsy();
    expect(existsSync(target)).toBe(true);
  });

  it('AFK_WORKSPACE_DISABLED fallback (Grok path): git-investigator still gets a restricted inner dispatcher', async () => {
    const provider = await nodeProvider({ agent_type: 'git-investigator', model: 'grok-3' }, 'disabled');
    expect(provider, 'restricted named Grok node must be constructed even without WorkspaceStore').toBeDefined();
    expect(provider!.name).toBe('xai');

    const touched = join(tmp, 'xai-fallback-touched');
    const bash = await runXai(provider!, 'bash', { command: `touch ${touched}` });
    expect(bash.isError).toBe(true);
    expect(existsSync(touched)).toBe(false);

    const target = join(tmp, 'xai-fallback-wrote.txt');
    const w = await runXai(provider!, 'write_file', { file_path: target, content: 'x' });
    expect(w.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});
