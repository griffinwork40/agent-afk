/**
 * Surface child gate on the routes the factory path does not cover: the depth
 * cap (skill + agent), read-only phase providers (and their model-fallback
 * rebuild), inline skill handlers that fork through their OWN manager, and
 * the agent-route model-fallback rebuild. Real builders, real providers, real
 * dispatchers; a deny must be an ordinary permission-denied tool result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ModelProvider } from '../provider.js';
import type { AgentConfig, CanUseTool } from '../types.js';
import type { ToolResult } from './types.js';
import type { SessionToolDispatcher } from './dispatcher.js';
import { createChildProviderFactory } from './nesting.js';
import type { ChildToolOrigin } from './nesting.can-use-tool.js';
import { buildForkedChildConfig } from './skill-executor/fork-child-config.js';
import type { SkillExecutorInternals } from './skill-executor/types.js';
import { wireChildNesting } from './subagent/child-config.helpers.js';
import { assembleChildConfig, type AssembleChildConfigArgs } from '../subagent/fork-child-config.js';
import { buildForkModelFallback } from '../subagent/fork-model-fallback.js';
import { bareProviderResolver } from '../session/provider-lifecycle.js';
import { SkillExecutor } from './skill-executor.js';
import { registerSkill, _resetRegistry, type SkillExecutionContext } from '../../skills/skill-registry.js';
import { setMintChildGate, mintChildGate, mintChildGateOpt } from '../../skills/mint/_phases/child-gate.js';

vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn(async () => {}) }));

let tmp: string;
const opened: ModelProvider[] = [];
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'afk-gate-holes-')); _resetRegistry(); });
afterEach(() => {
  for (const p of opened.splice(0)) { try { p.close?.(); } catch { /* closed */ } }
  _resetRegistry();
  rmSync(tmp, { recursive: true, force: true });
});

const signal = new AbortController().signal;

function recordingGate(): { factory: (o: ChildToolOrigin) => CanUseTool; calls: Array<{ tool: string; origin: ChildToolOrigin }> } {
  const calls: Array<{ tool: string; origin: ChildToolOrigin }> = [];
  return {
    calls,
    factory: (origin) => async (tool) => {
      calls.push({ tool, origin });
      return tool === 'write_file' || tool === 'grep' ? { behavior: 'deny', message: `GUI denied ${tool}` } : { behavior: 'allow' };
    },
  };
}

function track(p: ModelProvider | undefined): ModelProvider {
  expect(p, 'a provider must be constructed').toBeDefined();
  opened.push(p!);
  return p!;
}

async function run(p: ModelProvider, tool: string, input: Record<string, unknown>): Promise<ToolResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (p as any).buildDispatcher('default', {
    cwd: tmp, readRoots: [tmp], writeRoots: [tmp], sessionId: 'root', parentSessionId: 'root', subagentId: 'child-1',
  }) as SessionToolDispatcher;
  return d.execute({ id: `${tool}-1`, name: tool, input, signal: new AbortController().signal });
}

/** Deny stops the tool (permission-denied); a later allowed tool still runs. */
async function expectDenyThenContinue(p: ModelProvider, deniedTool: 'grep' | 'write_file'): Promise<void> {
  const target = join(tmp, 'denied.txt');
  const r = deniedTool === 'grep'
    ? await run(p, 'grep', { pattern: 'x', path: tmp })
    : await run(p, 'write_file', { file_path: target, content: 'x' });
  expect(r.isError).toBe(true);
  expect(r.failureClass).toBe('permission-denied');
  expect(String(r.content)).toContain(`GUI denied ${deniedTool}`);
  expect(existsSync(target)).toBe(false);
  const ok = await run(p, 'read_file', { file_path: join(tmp, 'nope.txt') });
  expect(ok.failureClass).not.toBe('permission-denied');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const optsOf = (p: ModelProvider): any => (p as any).providerOpts ?? p;

function capInternals(factory: ReturnType<typeof createChildProviderFactory> | undefined): SkillExecutorInternals {
  return {
    currentCwd: tmp,
    ctx: {
      parentSession: { sessionId: 'root', getInputStreamRef: () => ({ pushUserMessage: () => {} }), abortSignal: signal },
      defaultModel: 'sonnet', defaultSubagentModel: 'sonnet', depth: 3, maxDepth: 3,
      ...(factory !== undefined ? { childProviderFactory: factory } : {}),
    } as SkillExecutorInternals['ctx'],
  };
}

describe.each(['sonnet', 'gpt-4o'] as const)('depth-cap skill child — %s', (model) => {
  it('read-only skill at the cap (buildReadOnlyReconProvider): allowlist first, then the surface gate', async () => {
    const g = recordingGate();
    const { childConfig } = buildForkedChildConfig(capInternals(createChildProviderFactory({ childCanUseTool: g.factory })),
      { model, skillDispatchName: 'recon' } as AgentConfig, signal, true);
    const p = track(childConfig.provider);
    // write_file is outside RECON: the allowlist denies it before the human is asked.
    const w = await run(p, 'write_file', { file_path: join(tmp, 'w.txt'), content: 'x' });
    expect(w.isError).toBe(true);
    expect(g.calls.some((c) => c.tool === 'write_file')).toBe(false);
    await expectDenyThenContinue(p, 'grep');
    expect(g.calls[0]?.origin).toEqual({ route: 'skill', depth: 4, agentType: 'recon' });
  });

  it('tools-list skill at the cap (buildSkillRestrictedProvider): gated', async () => {
    const g = recordingGate();
    const { childConfig } = buildForkedChildConfig(capInternals(createChildProviderFactory({ childCanUseTool: g.factory })),
      { model, skillDispatchName: 'writer' } as AgentConfig, signal, false, ['write_file', 'read_file']);
    await expectDenyThenContinue(track(childConfig.provider), 'write_file');
    expect(g.calls.map((c) => c.origin.route)).toEqual(['skill', 'skill']);
  });
});

describe('depth-cap skill child with no tools list (no prebuilt provider)', () => {
  it('gate lands on config.canUseTool, which the bare resolver builds into the provider', async () => {
    const g = recordingGate();
    const { childConfig } = buildForkedChildConfig(capInternals(createChildProviderFactory({ childCanUseTool: g.factory })),
      { model: 'sonnet', skillDispatchName: 'plain' } as AgentConfig, signal);
    expect(childConfig.provider).toBeUndefined();
    await expectDenyThenContinue(track(bareProviderResolver(childConfig)('sonnet')), 'write_file');
    expect(g.calls[0]?.origin).toEqual({ route: 'skill', depth: 4, agentType: 'plain' });
  });
});

function capNesting(factory: ReturnType<typeof createChildProviderFactory>, allowed: string[] | undefined, model = 'sonnet') {
  const childConfig: AgentConfig = { model };
  const result = wireChildNesting({
    args: {
      parsed: { id_prefix: 'leaf' }, defaultConfig: {}, childProviderFactory: factory, namedAgent: undefined,
    } as unknown as Parameters<typeof wireChildNesting>[0]['args'],
    childConfig, effectiveAllowedTools: allowed, effectiveReadOnlyBash: false, resolvedAccess: undefined,
    depth: 3, maxDepth: 3, signal, currentCwd: tmp, createChildExecutor: () => { throw new Error('no nesting at the cap'); },
  });
  return { childConfig, result };
}

describe('depth-cap agent child', () => {
  it('agent with a tool list at the cap (buildSkillRestrictedProvider) and its model-fallback rebuild are gated', async () => {
    const g = recordingGate();
    const { childConfig, result } = capNesting(createChildProviderFactory({ childCanUseTool: g.factory }), ['write_file', 'read_file']);
    await expectDenyThenContinue(track(childConfig.provider), 'write_file');
    expect(g.calls[0]?.origin).toEqual({ route: 'agent', depth: 4, label: 'leaf' });
    const rebuilt = track(result.rebuildProvider?.('gpt-4o'));
    expect(rebuilt.name).toBe('openai-compatible');
    await expectDenyThenContinue(rebuilt, 'write_file');
  });

  it('agent with no tool list at the cap: gate on config.canUseTool, enforced by the bare resolver', async () => {
    const g = recordingGate();
    const { childConfig } = capNesting(createChildProviderFactory({ childCanUseTool: g.factory }), undefined);
    expect(childConfig.provider).toBeUndefined();
    await expectDenyThenContinue(track(bareProviderResolver(childConfig)('sonnet')), 'write_file');
  });
});

describe('agent-route model-fallback rebuild (factory path, below the cap)', () => {
  it('rebuildProvider for the fallback model consults the gate again', async () => {
    const g = recordingGate();
    const childConfig: AgentConfig = { model: 'sonnet' };
    const result = wireChildNesting({
      args: { parsed: { id_prefix: 'fb' }, defaultConfig: {}, childProviderFactory: createChildProviderFactory({ childCanUseTool: g.factory }) } as unknown as Parameters<typeof wireChildNesting>[0]['args'],
      childConfig, effectiveAllowedTools: undefined, effectiveReadOnlyBash: false, resolvedAccess: undefined,
      depth: 0, maxDepth: 3, signal, currentCwd: tmp, createChildExecutor: () => ({}) as never,
    });
    track(childConfig.provider);
    result.childManager?.teardownAll?.();
    const rebuilt = track(result.rebuildProvider?.('gpt-4o'));
    await expectDenyThenContinue(rebuilt, 'write_file');
    expect(g.calls[0]?.origin).toEqual({ route: 'agent', depth: 1, label: 'fb' });
  });
});

function phaseArgs(canUseTool: CanUseTool | undefined): AssembleChildConfigArgs<unknown> {
  return {
    options: { parent: { sessionId: 'root' }, config: { model: 'sonnet', systemPrompt: 'spec', ...(canUseTool ? { canUseTool } : {}) }, phaseRole: 'read-only', agentType: 'mint-spec' },
    id: 'child', resume: undefined, registry: undefined, effectiveChildModel: 'sonnet', effectiveTimeoutMs: 30_000,
    inheritedReadRoots: undefined, composedWriteRoots: undefined, childController: new AbortController(),
    parentCwd: undefined, parentApiKey: undefined, parentBaseUrl: undefined, parentProvider: undefined,
    parentTraceWriter: undefined, parentSurface: undefined, parentCanUseTool: undefined, parentRootSessionId: undefined,
    workspaceStore: undefined,
  } as AssembleChildConfigArgs<unknown>;
}

describe('read-only phase provider (buildPhaseRestrictedProvider)', () => {
  it('fork config canUseTool reaches the phase provider, and its model-fallback rebuild', async () => {
    const g = recordingGate();
    const gate = g.factory({ route: 'skill', depth: 1, agentType: 'mint-spec' });
    const cfg = assembleChildConfig(phaseArgs(gate));
    await expectDenyThenContinue(track(cfg.provider), 'grep');
    const fb = buildForkModelFallback({
      options: { ...phaseArgs(gate).options, modelFallback: { model: 'gpt-4o' } }, childConfig: cfg, id: 'child',
      parentApiKey: undefined, parentBaseUrl: undefined, parentProvider: undefined, workspaceStore: undefined,
    });
    const session = fb!.createSession();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rebuilt = track((session as any).config?.provider ?? (session as any).initialConfig?.provider);
    await expectDenyThenContinue(rebuilt, 'grep');
    await session.close?.();
  });
});

describe('inline skill handlers', () => {
  it('SkillExecutor hands the inline handler a childGate labelled route skill, depth+1', async () => {
    const g = recordingGate();
    let seen: SkillExecutionContext | undefined;
    registerSkill({ name: 'inline-probe', description: 'p', handler: async (_i, _s, ctx) => { seen = ctx; return 'ok'; } });
    const ex = new SkillExecutor({
      parentSession: { sessionId: 'root', getInputStreamRef: () => ({ pushUserMessage: () => {} }), abortSignal: signal },
      defaultModel: 'sonnet', defaultSubagentModel: 'sonnet', depth: 0, maxDepth: 3, cwd: tmp,
      childProviderFactory: createChildProviderFactory({ childCanUseTool: g.factory }),
    } as ConstructorParameters<typeof SkillExecutor>[0]);
    await ex.execute({ id: 's', name: 'skill', input: { name: 'inline-probe' }, signal });
    const gate = seen?.childGate?.('user-skill-x');
    expect(gate).toBeDefined();
    // The fork config built from it is enforced by the child's bare resolver.
    const p = track(bareProviderResolver({ model: 'sonnet', canUseTool: gate! })('sonnet'));
    await expectDenyThenContinue(p, 'write_file');
    expect(g.calls[0]?.origin).toEqual({ route: 'skill', depth: 1, agentType: 'user-skill-x' });
  });

  it('mint phase gate: recorded per session, spread into fork configs, cleared on reset', () => {
    const g = recordingGate();
    setMintChildGate('s1', (t) => g.factory({ route: 'skill', depth: 1, agentType: t }));
    expect(mintChildGate('s1', 'mint-build')).toHaveProperty('canUseTool');
    expect(mintChildGateOpt('s1')).toHaveProperty('childGate');
    expect(mintChildGate('s2', 'mint-build')).toEqual({});
    setMintChildGate('s1', undefined);
    expect(mintChildGate('s1', 'mint-build')).toEqual({});
    expect(mintChildGateOpt('s1')).toEqual({});
  });
});

describe('gate absent: every hole route builds exactly what it built before', () => {
  it('no canUseTool key on any provider or config, and no handler context key', async () => {
    const plain = createChildProviderFactory({});
    const a = buildForkedChildConfig(capInternals(plain), { model: 'sonnet' } as AgentConfig, signal, true).childConfig;
    const b = buildForkedChildConfig(capInternals(plain), { model: 'sonnet' } as AgentConfig, signal, false, ['read_file']).childConfig;
    const c = buildForkedChildConfig(capInternals(plain), { model: 'sonnet' } as AgentConfig, signal).childConfig;
    const d = capNesting(plain, ['write_file', 'read_file']).childConfig;
    const e = capNesting(plain, undefined).childConfig;
    const f = assembleChildConfig(phaseArgs(undefined));
    for (const p of [a.provider, b.provider, d.provider, f.provider]) expect(optsOf(track(p)).canUseTool).toBeUndefined();
    for (const cfg of [a, b, c, d, e]) expect('canUseTool' in cfg).toBe(false);
    const target = join(tmp, 'ungated.txt');
    const w = await run(track(d.provider), 'write_file', { file_path: target, content: 'x' });
    expect(w.isError).toBeFalsy();
    expect(existsSync(target)).toBe(true);
    let seen: SkillExecutionContext | undefined;
    registerSkill({ name: 'inline-probe', description: 'p', handler: async (_i, _s, ctx) => { seen = ctx; return 'ok'; } });
    await new SkillExecutor({
      parentSession: { sessionId: 'root', getInputStreamRef: () => ({ pushUserMessage: () => {} }), abortSignal: signal },
      defaultModel: 'sonnet', defaultSubagentModel: 'sonnet', depth: 0, maxDepth: 3, cwd: tmp, childProviderFactory: plain,
    } as ConstructorParameters<typeof SkillExecutor>[0]).execute({ id: 's', name: 'skill', input: { name: 'inline-probe' }, signal });
    expect(seen).toBeDefined();
    expect('childGate' in seen!).toBe(false);
  });
});
