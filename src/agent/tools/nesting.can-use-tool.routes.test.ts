/**
 * Harness-level proof that a surface-supplied `childCanUseTool` gate reaches
 * EVERY forked child's dispatcher, through every in-process fork route, and
 * that a deny stops the tool with an ordinary permission-denied result.
 *
 * Real wireExecutors / executors / child-config builders / provider factories /
 * dispatchers; only SubagentManager is replaced by a recorder that captures the
 * child AgentConfig (whose `provider` is the constructed child provider) and
 * then refuses to run a model. The test drives the captured provider's real
 * per-query dispatcher, exactly as the forked child session would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ModelProvider } from '../provider.js';
import type { AgentConfig } from '../types.js';
import type { CanUseTool } from '../types.js';
import type { ToolResult } from './types.js';
import type { SessionToolDispatcher } from './dispatcher.js';
import type { ChildToolOrigin } from './nesting.can-use-tool.js';

const forks = vi.hoisted(() => ({ configs: [] as AgentConfig[] }));
vi.mock('../subagent.js', () => ({
  SUBAGENT_BACKGROUND_TIMEOUT_MS: 60_000,
  SubagentManager: vi.fn(function () {
    return {
      billingStreamRegistry: new Set(),
      forkSubagent: vi.fn(async (opts: { config: AgentConfig }) => {
        forks.configs.push(opts.config);
        throw new Error('recorder: fork captured');
      }),
      setCwd: vi.fn(), setTraceWriter: vi.fn(), teardownAll: vi.fn(async () => {}),
      kill: vi.fn(async () => true), reportSubagentCompletion: vi.fn(),
      getReadScopeInputs: vi.fn(() => ({})),
    };
  }),
}));
const mockRunSubagentDAG = vi.fn();
vi.mock('../dag-subagent.js', () => ({ runSubagentDAG: (...a: unknown[]) => mockRunSubagentDAG(...a) }));
vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn(async () => {}) }));

import { wireExecutors, type WireExecutorsOptions } from '../session/wire-executors.js';
import type { SubagentExecutorContext } from './subagent-executor.js';
import type { SkillExecutorContext } from './skill-executor/types.js';
import { executePluginSkill } from './skill-executor/fork-dispatch.js';
import { registerSkill, _resetRegistry } from '../../skills/skill-registry.js';
import * as promptLoader from '../../skills/_lib/prompt-loader.js';

let tmp: string;
let prevHome: string | undefined;
const opened: ModelProvider[] = [];

beforeEach(() => {
  forks.configs.length = 0;
  mockRunSubagentDAG.mockReset();
  mockRunSubagentDAG.mockResolvedValue({ outputs: {}, failed: [], skipped: [] });
  tmp = mkdtempSync(join(tmpdir(), 'afk-child-gate-'));
  prevHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
  _resetRegistry();
  registerSkill({ name: 'gate-probe', description: 'probe', context: 'fork', handler: vi.fn() });
  vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'Probe instructions' });
});
afterEach(() => {
  for (const p of opened.splice(0)) { try { p.close?.(); } catch { /* already closed */ } }
  vi.restoreAllMocks();
  _resetRegistry();
  if (prevHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

const signal = new AbortController().signal;
function last<T>(xs: readonly T[]): T | undefined { return xs[xs.length - 1]; }
type Wired = ReturnType<typeof wireExecutors>;

function wire(extra: Partial<WireExecutorsOptions>): Wired {
  return wireExecutors({
    surface: 'cli',
    parentSession: { sessionId: 'root', getInputStreamRef: () => ({ pushUserMessage: () => {} }), abortSignal: signal } as unknown as SubagentExecutorContext['parentSession'],
    apiKey: 'k', model: 'sonnet', managerParentModel: 'sonnet', defaultSubagentModel: 'sonnet',
    resolveApiKeyForModel: () => 'k', cwd: tmp, agentRegistryWarn: () => {},
    ...extra,
  });
}

/** A recording gate factory: denies write_file, allows everything else. */
function recordingGate(): { factory: (o: ChildToolOrigin) => CanUseTool; origins: ChildToolOrigin[]; calls: Array<{ tool: string; origin: ChildToolOrigin }> } {
  const origins: ChildToolOrigin[] = [];
  const calls: Array<{ tool: string; origin: ChildToolOrigin }> = [];
  const factory = (origin: ChildToolOrigin): CanUseTool => {
    origins.push(origin);
    return async (tool) => {
      calls.push({ tool, origin });
      return tool === 'write_file' ? { behavior: 'deny', message: `GUI denied ${tool}` } : { behavior: 'allow' };
    };
  };
  return { factory, origins, calls };
}

function lastProvider(): ModelProvider {
  const p = last(forks.configs)?.provider;
  expect(p, 'child fork must carry a constructed provider').toBeDefined();
  opened.push(p!);
  return p!;
}

async function runInChild(provider: ModelProvider, tool: string, input: Record<string, unknown>): Promise<ToolResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (provider as any).buildDispatcher('default', {
    cwd: tmp, readRoots: [tmp], writeRoots: [tmp], sessionId: 'root', parentSessionId: 'root', subagentId: 'child-1',
  }) as SessionToolDispatcher;
  return d.execute({ id: `${tool}-1`, name: tool, input, signal: new AbortController().signal });
}

async function expectDeniedWrite(provider: ModelProvider): Promise<void> {
  const target = join(tmp, `denied-${forks.configs.length}.txt`);
  const r = await runInChild(provider, 'write_file', { file_path: target, content: 'x' });
  expect(r.isError).toBe(true);
  expect(String(r.content)).toContain('GUI denied write_file');
  expect(r.failureClass).toBe('permission-denied');
  expect(existsSync(target)).toBe(false);
}

async function agentCall(executor: { execute: Wired['subagentExecutor']['execute'] }, input: Record<string, unknown>): Promise<void> {
  await executor.execute({ id: 'agent-call', name: 'agent', input, signal });
}

describe.each([['sonnet', 'anthropic-direct'], ['gpt-4o', 'openai-compatible']] as const)('child gate routes — %s', (model, providerName) => {
  it('agent tool (unnamed, depth 1): child write_file asks the gate and a deny stops it', async () => {
    const g = recordingGate();
    const w = wire({ childCanUseTool: g.factory, defaultSubagentModel: model });
    await agentCall(w.subagentExecutor, { prompt: 'do it', id_prefix: 'worker', model });
    const p = lastProvider();
    expect(p.name).toBe(providerName);
    await expectDeniedWrite(p);
    expect(g.calls).toEqual([{ tool: 'write_file', origin: { route: 'agent', depth: 1, label: 'worker' } }]);
    // An allowed tool runs normally after a deny (child keeps going).
    const ok = await runInChild(p, 'list_directory', { path: tmp });
    expect(ok.isError).toBeFalsy();
  });

  it('agent tool, read-only named agent (research-agent): gated, labelled with agent type', async () => {
    const g = recordingGate();
    const w = wire({ childCanUseTool: g.factory });
    await agentCall(w.subagentExecutor, { prompt: 'look', agent_type: 'research-agent', model });
    const p = lastProvider();
    const r = await runInChild(p, 'read_file', { file_path: join(tmp, 'nope.txt') });
    expect(r.failureClass).not.toBe('permission-denied');
    expect(last(g.calls)?.origin).toMatchObject({ route: 'agent', depth: 1, agentType: 'research-agent' });
  });

  it('agent tool depth 2: a depth-1 child\'s own agent dispatch builds a gated depth-2 child', async () => {
    const g = recordingGate();
    const w = wire({ childCanUseTool: g.factory });
    await agentCall(w.subagentExecutor, { prompt: 'outer', model });
    const depth1 = lastProvider();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nested = (depth1 as any).subagentExecutor ?? (depth1 as any).providerOpts?.subagentExecutor;
    expect(nested, 'depth-1 provider must carry a nested agent executor').toBeDefined();
    await agentCall(nested, { prompt: 'inner', id_prefix: 'grandchild', model });
    const depth2 = lastProvider();
    expect(depth2).not.toBe(depth1);
    await expectDeniedWrite(depth2);
    expect(last(g.calls)?.origin).toEqual({ route: 'agent', depth: 2, label: 'grandchild' });
  });

  it('cross-route depth 2: skill child -> agent and agent child -> skill are both gated', async () => {
    const g = recordingGate();
    const w = wire({ childCanUseTool: g.factory, defaultSubagentModel: model, model });
    await w.skillExecutor.execute({ id: 's', name: 'skill', input: { name: 'gate-probe' }, signal }).catch(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skillChild = lastProvider() as any;
    await agentCall(skillChild.subagentExecutor ?? skillChild.providerOpts?.subagentExecutor, { prompt: 'x', id_prefix: 'from-skill', model });
    await expectDeniedWrite(lastProvider());
    expect(last(g.calls)?.origin).toEqual({ route: 'agent', depth: 2, label: 'from-skill' });
    await agentCall(w.subagentExecutor, { prompt: 'y', model });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentChild = lastProvider() as any;
    const nestedSkill = agentChild.skillExecutor ?? agentChild.providerOpts?.skillExecutor;
    expect(nestedSkill, 'depth-1 agent child must carry a nested skill executor').toBeDefined();
    await nestedSkill.execute({ id: 's2', name: 'skill', input: { name: 'gate-probe' }, signal }).catch(() => undefined);
    await expectDeniedWrite(lastProvider());
    // The nested skill executor knows its directory, so the origin names it.
    expect(last(g.calls)?.origin).toEqual({ route: 'skill', depth: 2, agentType: 'gate-probe', cwd: tmp });
  });

  it('agent tool with its own cwd: the child origin carries that cwd for the gate', async () => {
    const g = recordingGate();
    const w = wire({ childCanUseTool: g.factory, defaultSubagentModel: model });
    const own = join(tmp, 'own-cwd');
    mkdirSync(own, { recursive: true });
    await agentCall(w.subagentExecutor, { prompt: 'do it', id_prefix: 'moved', cwd: own, model });
    await expectDeniedWrite(lastProvider());
    expect(last(g.calls)?.origin).toEqual({ route: 'agent', depth: 1, label: 'moved', cwd: own });
  });

  it('agent tool, background mode: child provider is gated (same construction path)', async () => {
    const g = recordingGate();
    const registry = { register: vi.fn(), get: vi.fn(), list: vi.fn(() => []) };
    const w = wire({ childCanUseTool: g.factory, backgroundRegistry: registry as never });
    await agentCall(w.subagentExecutor, { prompt: 'bg', mode: 'background', id_prefix: 'bg', model });
    await expectDeniedWrite(lastProvider());
    expect(last(g.calls)?.origin).toEqual({ route: 'agent', depth: 1, label: 'bg' });
  });

  it('skill tool, forked registry skill: child gated with route skill', async () => {
    const g = recordingGate();
    const w = wire({ childCanUseTool: g.factory, defaultSubagentModel: model, model });
    await w.skillExecutor.execute({ id: 'skill-call', name: 'skill', input: { name: 'gate-probe' }, signal }).catch(() => undefined);
    const p = lastProvider();
    expect(p.name).toBe(providerName);
    await expectDeniedWrite(p);
    expect(last(g.calls)?.origin).toEqual({ route: 'skill', depth: 1, agentType: 'gate-probe' });
  });

  it('skill tool, forked plugin skill (context: fork): child gated', async () => {
    const g = recordingGate();
    const w = wire({ childCanUseTool: g.factory, defaultSubagentModel: model, model });
    const ctx = (w.skillExecutor as unknown as { ctx: SkillExecutorContext }).ctx;
    await executePluginSkill({ ctx, currentCwd: tmp }, 'plugin-probe', 'Probe', join(tmp, 'plugin'), undefined,
      { id: 'plugin-call', name: 'skill', input: { name: 'plugin-probe' }, signal }).catch(() => undefined);
    const p = lastProvider();
    await expectDeniedWrite(p);
    expect(last(g.calls)?.origin).toMatchObject({ route: 'skill', depth: 1, agentType: 'plugin-probe' });
  });

  it('compose DAG nodes (unnamed and named read-only): gate chained after the node allowlist', async () => {
    const g = recordingGate();
    const w = wire({ childCanUseTool: g.factory, defaultSubagentModel: model });
    await w.composeExecutor.execute({ id: 'compose-call', name: 'compose', signal, input: { nodes: [
      { id: 'a', prompt: 'task', model },
      { id: 'b', prompt: 'look', agent_type: 'research-agent', model },
    ] } });
    const nodes = (mockRunSubagentDAG.mock.calls[0]?.[0] as { nodes: Array<{ provider?: ModelProvider }> }).nodes;
    const [a, b] = [nodes[0]?.provider, nodes[1]?.provider];
    expect(a).toBeDefined(); expect(b).toBeDefined();
    opened.push(a!, b!);
    await expectDeniedWrite(a!);
    expect(last(g.calls)?.origin).toEqual({ route: 'compose', depth: 1, label: 'a', cwd: tmp });
    // research-agent's own allowlist denies write_file BEFORE the human is asked.
    const before = g.calls.length;
    const r = await runInChild(b!, 'write_file', { file_path: join(tmp, 'b.txt'), content: 'x' });
    expect(r.isError).toBe(true);
    expect(g.calls.length).toBe(before);
    await runInChild(b!, 'read_file', { file_path: join(tmp, 'nope.txt') });
    expect(last(g.calls)).toMatchObject({ tool: 'read_file', origin: { route: 'compose', agentType: 'research-agent', label: 'b' } });
  });
});

describe('child gate absent: behaviour unchanged', () => {
  it('no gate key reaches any child provider and every child tool runs unasked', async () => {
    const w = wire({});
    await agentCall(w.subagentExecutor, { prompt: 'do it' });
    const p = lastProvider();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((p as any).canUseTool).toBeUndefined();
    const target = join(tmp, 'ungated.txt');
    const r = await runInChild(p, 'write_file', { file_path: target, content: 'x' });
    expect(r.isError).toBeFalsy();
    expect(existsSync(target)).toBe(true);
    await w.composeExecutor.execute({ id: 'c', name: 'compose', signal, input: { nodes: [{ id: 'a', prompt: 't' }] } });
    const nodes = (mockRunSubagentDAG.mock.calls[0]?.[0] as { nodes: Array<{ provider?: ModelProvider; canUseTool?: unknown }> }).nodes;
    // Unnamed node with a store-less session keeps the legacy no-provider path.
    expect(nodes[0]?.provider).toBeUndefined();
    expect(nodes[0]?.canUseTool).toBeUndefined();
  });
});
