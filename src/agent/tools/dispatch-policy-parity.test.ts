/**
 * Cross-path dispatch-policy parity matrix (#4042, stage 1).
 *
 * `SubagentManager.forkSubagent` is a trusting factory, not a policy
 * chokepoint: every caller runs its own pre-fork pipeline. Policy added to one
 * path has repeatedly failed OPEN on another (#3270 named-agent allowlist and
 * bashReadOnly on compose, #3944 read-only dispatch-intent gate on compose).
 *
 * This file declares ONE table, `DISPATCH_POLICY_MATRIX`, of
 * `policy x caller to 'enforced' | { na: reason } | { gap: description }`.
 * Every `'enforced'` cell is backed by a behavioral probe that drives that
 * caller's REAL dispatch code and asserts the policy bites (a refusal before
 * any fork, or a constructed child provider whose dispatcher rejects the
 * call). Only `forkSubagent` itself is stubbed (a prototype spy that captures
 * the fork options and returns a fake handle), so everything upstream of the
 * fork is production code. In particular the compose probes run the real
 * `ComposeExecutor` to `runSubagentDAG` to `dispatchDagNode` chain; nothing in
 * the DAG layer is mocked.
 *
 * Adding a policy or a caller: extend `POLICIES` / `CALLERS`, then fill every
 * new cell. The completeness test below fails until each (policy, caller)
 * pair has a decision and each enforced cell has a probe.
 *
 * Out of scope for this stage (follow-up): the other forkSubagent callers,
 * namely the mint phases (spec / research / plan / build / heal / verify /
 * parallelize), user-skills.ts, and audit-fit.
 *
 * Per INV-029 / REJ-005, `AgentConfig.tools.allowedTools` is telemetry only;
 * tool policy probes therefore assert on what the constructed provider's
 * dispatcher actually does, never on that field.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

vi.mock('../routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn(async () => {}),
}));
vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'test-credential' as string | undefined),
  loadAnthropicCredential: vi.fn(() => 'test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

import type { ToolCall, ToolResult } from './types.js';
import type { ModelProvider } from '../provider.js';
import type { SessionToolDispatcher } from './dispatcher.js';
import type { AgentConfig } from '../types/config-types.js';
import { SubagentManager } from '../subagent.js';
import { SubagentExecutor } from './subagent-executor.js';
import { ComposeExecutor } from './compose-executor.js';
import { SkillExecutor } from './skill-executor.js';
import { createChildProviderFactory } from './nesting.js';
import { DelegationBudget } from './delegation-budget.js';
import { builtinAgents } from '../agents/builtins.js';
import type { RegisteredAgent, AgentRegistry } from '../agents/index.js';
import { registerSkill, _resetRegistry } from '../../skills/skill-registry.js';
import * as promptLoader from '../../skills/_lib/prompt-loader.js';

// The matrix

export const CALLERS = ['agent', 'compose', 'skill-fork'] as const;
export type DispatchCaller = (typeof CALLERS)[number];

export const POLICIES = [
  /** Caller-declared tool restriction (named-agent allowlist, or read-only skill RECON set). */
  'tool-allowlist',
  /** Mutating bash is blocked for read-only children. */
  'read-only-bash',
  /** Read-only child refused when its brief asks for implementation (#3754). */
  'read-only-dispatch-intent',
  /** Dispatch refused at the nesting depth cap. */
  'max-depth-refusal',
  /** cwd / readRoots / writeRoots breadth + credential-root rejection. */
  'root-breadth-validation',
  /** Tree-wide delegation budget charged and enforced before forking. */
  'delegation-budget',
  /** isolation:"worktree" fails loud rather than falling back to the shared tree. */
  'worktree-isolation',
  /** list_sessions / send_to_session refused inside any forked child. */
  'child-peer-tool-block',
  /** A scoped agent's `Agent(x)` grant limits what it may dispatch. */
  'nested-agent-allowlist',
  /**
   * Stage 3 (#4042): model resolution follows the full four-tier chain
   * (callSite > namedAgent > defaultSubagentModel > defaultModel > 'sonnet')
   * on every dispatch path. Before this fix, dispatchDagNode used
   * `spec.model ?? 'sonnet'`, skipping tiers 3 and 4 for nodes whose
   * spec.model was absent (direct runSubagentDAG callers; compose always
   * pre-resolves via buildComposeDagNode so was unaffected in practice).
   */
  'model-resolution',
  /**
   * Stage 3 (#4042): named-agent `maxTurns` / `maxToolUseIterations` frontmatter
   * is honoured on every dispatch path (call-site > named-agent > unlimited).
   * Before this fix the compose path ignored named-agent budget frontmatter and
   * forwarded only the explicit per-node / per-compose-call values.
   */
  'named-agent-budget',
] as const;
export type DispatchPolicy = (typeof POLICIES)[number];

export type ParityCell = 'enforced' | { na: string } | { gap: string };

const PEER_BLOCK_NA =
  'caller independent: SubagentManager.forkSubagent stamps subagentId on EVERY fork ' +
  '(assembleChildConfig) and the dispatcher gate keys on it; covered by ' +
  'src/agent/subagent/fork-helpers.test.ts "stamps the manager-assigned id as subagentId" and ' +
  'src/agent/tools/compose-node-enforcement.test.ts "child dispatcher rejects list_sessions and send_to_session"';

export const DISPATCH_POLICY_MATRIX: Record<DispatchPolicy, Record<DispatchCaller, ParityCell>> = {
  'tool-allowlist': { agent: 'enforced', compose: 'enforced', 'skill-fork': 'enforced' },
  'read-only-bash': { agent: 'enforced', compose: 'enforced', 'skill-fork': 'enforced' },
  'read-only-dispatch-intent': {
    agent: 'enforced',
    compose: 'enforced',
    'skill-fork': {
      na: 'a skill fork has no caller-written brief to a typed read-only agent: the child runs its own ' +
        'SKILL.md and the only input is a fixed "Run the <name> skill" anchor plus verbatim arguments',
    },
  },
  'max-depth-refusal': { agent: 'enforced', compose: 'enforced', 'skill-fork': 'enforced' },
  'root-breadth-validation': {
    agent: 'enforced',
    compose: 'enforced',
    'skill-fork': {
      na: 'the skill tool input has no cwd / readRoots / writeRoots fields; the fork inherits the ' +
        'executor cwd and parent read scope (covered by src/agent/tools/skill-executor/read-scope.test.ts)',
    },
  },
  'delegation-budget': { agent: 'enforced', compose: 'enforced', 'skill-fork': 'enforced' },
  'worktree-isolation': {
    agent: 'enforced',
    compose: 'enforced',
    'skill-fork': { na: 'the skill tool input has no isolation field; skill forks always run in the executor cwd' },
  },
  'child-peer-tool-block': {
    agent: { na: PEER_BLOCK_NA },
    compose: { na: PEER_BLOCK_NA },
    'skill-fork': { na: PEER_BLOCK_NA },
  },
  'nested-agent-allowlist': {
    agent: 'enforced',
    compose: {
      na: 'intentional (#2848): DAG nodes are task workers, not scoped agents, so runSubagentDAG ' +
        'does not forward nestedAgentAllowlist (dag-subagent.ts), and compose nodes get no agent/skill executors',
    },
    'skill-fork': {
      na: 'intentional (#2848): skill forks carry no Agent(x) grant from a type definition, so there is ' +
        'no caller allowlist to forward (fork-dispatch.ts runForkedSkillToResult)',
    },
  },
  'model-resolution': {
    // Stage 3 (#4042): all three paths use resolveChildModel so the full
    // four-tier chain (callSite > namedAgent > defaultSubagentModel >
    // defaultModel > 'sonnet') is honoured everywhere.
    agent: 'enforced',
    compose: 'enforced',
    'skill-fork': 'enforced',
  },
  'named-agent-budget': {
    // Stage 3 (#4042): resolveChildBudgets (from child-config.helpers.ts) is
    // now called by buildComposeDagNode, applying the same call-site >
    // named-agent > unlimited precedence on the compose path.
    agent: 'enforced',
    compose: 'enforced',
    'skill-fork': {
      na: 'skill forks do not accept a named agent type in the input; the skill SKILL.md ' +
        'may declare a model but never declares maxTurns / maxToolUseIterations as frontmatter ' +
        '(those fields are agent-definition-specific)',
    },
  },
};

// Shared harness

let tmp: string;
const openProviders: ModelProvider[] = [];
let forkCalls: Array<{ config: AgentConfig } & Record<string, unknown>>;

function fakeHandle(n: number): unknown {
  const result = {
    id: `parity-child-${n}`,
    status: 'succeeded',
    message: { role: 'assistant', content: 'ok', timestamp: new Date() },
  };
  return {
    id: `parity-child-${n}`,
    status: 'succeeded',
    session: undefined,
    runToResult: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn(),
    teardown: vi.fn().mockResolvedValue(undefined),
    getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'afk-dispatch-parity-'));
  vi.stubEnv('AFK_HOME', tmp);
  forkCalls = [];
  vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(async (opts) => {
    forkCalls.push(opts as unknown as (typeof forkCalls)[number]);
    return fakeHandle(forkCalls.length) as Awaited<ReturnType<SubagentManager['forkSubagent']>>;
  });
  vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
  _resetRegistry();
  vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'You are a parity test skill.' });
});

afterEach(() => {
  for (const provider of openProviders.splice(0)) {
    try { void provider.close?.(); } catch { /* ignore: already closed */ }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetRegistry();
  rmSync(tmp, { recursive: true, force: true });
});

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `${name}-parity-1`, name, input, signal: new AbortController().signal };
}

/** The provider the captured fork would run with; tracked for afterEach close. */
function forkedProvider(): ModelProvider {
  expect(forkCalls, 'expected exactly one fork').toHaveLength(1);
  const provider = forkCalls[0]?.config.provider as ModelProvider | undefined;
  expect(provider, 'fork config must carry a constructed provider').toBeDefined();
  openProviders.push(provider!);
  return provider!;
}

/** Execute one tool call through the child dispatcher the provider would build. */
async function childRun(provider: ModelProvider, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatcher = (provider as any).buildDispatcher('default', {
    cwd: tmp,
    readRoots: [tmp],
    writeRoots: [tmp],
    sessionId: 'parent-session',
    parentSessionId: 'parent-session',
    subagentId: 'parity-child-1',
  }) as SessionToolDispatcher;
  return dispatcher.execute(call(name, input));
}

async function expectWriteDenied(provider: ModelProvider): Promise<void> {
  const target = join(tmp, 'parity-wrote.txt');
  const r = await childRun(provider, 'write_file', { file_path: target, content: 'x' });
  expect(r.isError).toBe(true);
  expect(existsSync(target)).toBe(false);
}

async function expectMutatingBashDenied(provider: ModelProvider): Promise<void> {
  const touched = join(tmp, 'parity-touched');
  const r = await childRun(provider, 'bash', { command: `touch ${touched}` });
  expect(r.isError).toBe(true);
  expect(String(r.content)).toContain('read-only');
  expect(existsSync(touched)).toBe(false);
}

function expectRefusedWithoutFork(r: ToolResult, fragment: string | RegExp): void {
  expect(r.isError).toBe(true);
  if (typeof fragment === 'string') expect(String(r.content)).toContain(fragment);
  else expect(String(r.content)).toMatch(fragment);
  expect(forkCalls).toHaveLength(0);
}

// Per-caller drivers (real production entry points)

interface DriverOpts {
  depth?: number;
  maxDepth?: number;
  delegationBudget?: DelegationBudget;
  nestedAgentAllowlist?: readonly string[];
  agentRegistry?: AgentRegistry;
}

async function runAgent(input: Record<string, unknown>, o: DriverOpts = {}): Promise<ToolResult> {
  const executor = new SubagentExecutor({
    subagentManager: new SubagentManager({ cwd: tmp }),
    parentSession: {
      sessionId: 'parent-session',
      getInputStreamRef: () => ({ pushUserMessage: () => {} }),
      abortSignal: new AbortController().signal,
    } as never,
    defaultConfig: { apiKey: 'test-key', systemPrompt: 'base prompt' },
    defaultSubagentModel: 'sonnet',
    depth: o.depth ?? 0,
    ...(o.maxDepth !== undefined ? { maxDepth: o.maxDepth } : {}),
    childProviderFactory: createChildProviderFactory(),
    agentRegistry: builtinAgents(),
    parentModel: 'sonnet',
    cwd: tmp,
    ...(o.delegationBudget !== undefined ? { delegationBudget: o.delegationBudget } : {}),
    ...(o.nestedAgentAllowlist !== undefined ? { nestedAgentAllowlist: o.nestedAgentAllowlist } : {}),
  });
  return executor.execute(call('agent', { model: 'sonnet', ...input }));
}

async function runCompose(node: Record<string, unknown>, o: DriverOpts = {}): Promise<ToolResult> {
  const executor = new ComposeExecutor({
    parentSession: { sessionId: 'parent-session', abortSignal: new AbortController().signal },
    apiKey: 'test-key',
    systemPrompt: 'base prompt',
    agentRegistry: o.agentRegistry ?? builtinAgents(),
    defaultSubagentModel: 'sonnet',
    resolveApiKeyForModel: () => 'test-key',
    cwd: tmp,
    ...(o.depth !== undefined ? { depth: o.depth } : {}),
    ...(o.maxDepth !== undefined ? { maxDepth: o.maxDepth } : {}),
    ...(o.delegationBudget !== undefined ? { delegationBudget: o.delegationBudget } : {}),
  });
  return executor.execute(
    call('compose', { nodes: [{ id: 'a', prompt: 'inspect the module', model: 'sonnet', ...node }] }),
  );
}

async function runSkillFork(skill: { readOnly?: boolean }, o: DriverOpts = {}): Promise<ToolResult> {
  registerSkill({
    name: 'parity-skill',
    description: 'parity probe skill',
    context: 'fork',
    ...(skill.readOnly === true ? { readOnly: true } : {}),
    handler: vi.fn(),
  });
  const executor = new SkillExecutor({
    parentSession: {
      sessionId: 'parent-session',
      getInputStreamRef: () => ({ pushUserMessage: () => {} }),
      abortSignal: new AbortController().signal,
    },
    defaultModel: 'sonnet',
    defaultSubagentModel: 'sonnet',
    apiKey: 'test-key',
    cwd: tmp,
    childProviderFactory: createChildProviderFactory(),
    depth: o.depth ?? 0,
    ...(o.maxDepth !== undefined ? { maxDepth: o.maxDepth } : {}),
    ...(o.delegationBudget !== undefined ? { delegationBudget: o.delegationBudget } : {}),
  });
  return executor.execute(call('skill', { name: 'parity-skill' }));
}

const exhaustedBudget = (): DelegationBudget => new DelegationBudget({ maxTotalAgents: 0 });
const IMPL_BRIEF = 'fix the bug in auth.ts';

// Probes: one per 'enforced' cell

type CellKey = `${DispatchPolicy}:${DispatchCaller}`;

const PROBES: Partial<Record<CellKey, () => Promise<void>>> = {
  // tool-allowlist
  'tool-allowlist:agent': async () => {
    const r = await runAgent({ prompt: 'inspect the module', agent_type: 'research-agent' });
    expect(r.isError).toBeFalsy();
    await expectWriteDenied(forkedProvider());
  },
  'tool-allowlist:compose': async () => {
    await runCompose({ agent_type: 'research-agent' });
    await expectWriteDenied(forkedProvider());
  },
  'tool-allowlist:skill-fork': async () => {
    const r = await runSkillFork({ readOnly: true });
    expect(r.isError).toBeFalsy();
    await expectWriteDenied(forkedProvider());
  },

  // read-only-bash
  'read-only-bash:agent': async () => {
    await runAgent({ prompt: 'inspect the history', agent_type: 'git-investigator' });
    await expectMutatingBashDenied(forkedProvider());
  },
  'read-only-bash:compose': async () => {
    await runCompose({ agent_type: 'git-investigator' });
    await expectMutatingBashDenied(forkedProvider());
  },
  'read-only-bash:skill-fork': async () => {
    await runSkillFork({ readOnly: true });
    await expectMutatingBashDenied(forkedProvider());
  },

  // read-only-dispatch-intent
  'read-only-dispatch-intent:agent': async () => {
    const r = await runAgent({ prompt: IMPL_BRIEF, agent_type: 'research-agent' });
    expectRefusedWithoutFork(r, 'fix the bug');
  },
  'read-only-dispatch-intent:compose': async () => {
    const r = await runCompose({ prompt: IMPL_BRIEF, agent_type: 'research-agent' });
    expectRefusedWithoutFork(r, 'fix the bug');
  },

  // max-depth-refusal
  'max-depth-refusal:agent': async () => {
    const r = await runAgent({ prompt: 'inspect' }, { depth: 3, maxDepth: 3 });
    expectRefusedWithoutFork(r, 'nesting depth 3');
  },
  'max-depth-refusal:compose': async () => {
    const r = await runCompose({}, { depth: 3, maxDepth: 3 });
    expectRefusedWithoutFork(r, 'nesting depth 3');
  },
  'max-depth-refusal:skill-fork': async () => {
    const r = await runSkillFork({}, { depth: 3, maxDepth: 3 });
    expectRefusedWithoutFork(r, 'nesting depth 3');
  },

  // root-breadth-validation
  'root-breadth-validation:agent': async () => {
    const r = await runAgent({ prompt: 'inspect', cwd: homedir() });
    expectRefusedWithoutFork(r, /too broad|home/i);
  },
  'root-breadth-validation:compose': async () => {
    const r = await runCompose({ cwd: homedir() });
    expectRefusedWithoutFork(r, /too broad|home/i);
  },

  // delegation-budget
  'delegation-budget:agent': async () => {
    const r = await runAgent({ prompt: 'inspect' }, { delegationBudget: exhaustedBudget() });
    expectRefusedWithoutFork(r, /max 0/);
  },
  'delegation-budget:compose': async () => {
    // Enforced per node inside the real dispatchDagNode (not compose-executor).
    const r = await runCompose({}, { delegationBudget: exhaustedBudget() });
    expectRefusedWithoutFork(r, 'delegation budget');
  },
  'delegation-budget:skill-fork': async () => {
    const r = await runSkillFork({}, { delegationBudget: exhaustedBudget() });
    expectRefusedWithoutFork(r, 'delegation budget');
  },

  // worktree-isolation: tmp is not a git repo, so isolation must fail loud
  // instead of silently forking into the shared tree.
  'worktree-isolation:agent': async () => {
    const r = await runAgent({ prompt: 'inspect', isolation: 'worktree' });
    expectRefusedWithoutFork(r, 'isolated worktree');
  },
  'worktree-isolation:compose': async () => {
    const r = await runCompose({ isolation: 'worktree' });
    expectRefusedWithoutFork(r, 'isolated worktree');
  },

  // named-agent-budget (Stage 3, #4042)
  // Agent path: resolveChildBudgets already applies named-agent frontmatter
  // via child-config.helpers.ts. Probe: research-agent declares
  // maxToolUseIterations: 50 in its definition; no per-call override →
  // fork config receives maxToolUseIterations=50.
  'named-agent-budget:agent': async () => {
    const registry = builtinAgents();
    const researchAgent = registry.get('research-agent');
    expect(researchAgent?.definition.maxToolUseIterations, 'research-agent must declare maxToolUseIterations').toBeGreaterThan(0);
    const namedAgentBudget = researchAgent!.definition.maxToolUseIterations!;
    await runAgent({ prompt: 'inspect the module', agent_type: 'research-agent' });
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]?.config.maxToolUseIterations).toBe(namedAgentBudget);
  },

  // Compose path: buildComposeDagNode now calls resolveChildBudgets, so the
  // named-agent frontmatter budget is forwarded to the DAG node.
  // Sub-check A: compose node uses research-agent (maxToolUseIterations=50); no
  // per-node max_tool_rounds override → fork config receives 50.
  // Sub-check B: synthetic agent declares BOTH maxTurns=7 and maxToolUseIterations=33
  // (research-agent does not declare maxTurns) — same pattern as
  // compose-executor.test.ts agentWithBudget — verifying maxTurns is also
  // forwarded end-to-end through buildComposeDagNode.
  'named-agent-budget:compose': async () => {
    // Sub-check A: maxToolUseIterations forwarded via research-agent.
    const registry = builtinAgents();
    const researchAgent = registry.get('research-agent');
    expect(researchAgent?.definition.maxToolUseIterations, 'research-agent must declare maxToolUseIterations').toBeGreaterThan(0);
    const namedAgentBudget = researchAgent!.definition.maxToolUseIterations!;
    await runCompose({ agent_type: 'research-agent' });
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]?.config.maxToolUseIterations).toBe(namedAgentBudget);

    // Sub-check B: both maxTurns AND maxToolUseIterations forwarded via synthetic agent.
    forkCalls.splice(0);
    const syntheticAgent: RegisteredAgent = {
      name: 'synthetic-budget-agent',
      definition: {
        description: 'Synthetic agent for budget forwarding probe.',
        prompt: 'You are a synthetic budget probe agent.',
        maxTurns: 7,
        maxToolUseIterations: 33,
      },
      source: 'config',
    };
    const syntheticRegistry: AgentRegistry = new Map([
      ['synthetic-budget-agent', syntheticAgent],
    ]);
    await runCompose({ agent_type: 'synthetic-budget-agent' }, { agentRegistry: syntheticRegistry });
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]?.config.maxToolUseIterations).toBe(33);
    expect(forkCalls[0]?.config.maxTurns).toBe(7);
  },

  // nested-agent-allowlist
  'nested-agent-allowlist:agent': async () => {
    const r = await runAgent(
      { prompt: 'inspect', agent_type: 'research-agent' },
      { nestedAgentAllowlist: ['git-investigator'] },
    );
    expectRefusedWithoutFork(r, 'research-agent');
  },

  // model-resolution (Stage 3, #4042)
  // Agent path: resolveChildModel is already the single source of truth in
  // child-config.helpers.ts. Probe: defaultSubagentModel='haiku' and no
  // call-site model override → fork receives 'haiku', not 'sonnet'.
  'model-resolution:agent': async () => {
    const executor = new SubagentExecutor({
      subagentManager: new SubagentManager({ cwd: tmp }),
      parentSession: {
        sessionId: 'parent-session',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal: new AbortController().signal,
      } as never,
      defaultConfig: { apiKey: 'test-key', systemPrompt: 'base prompt' },
      defaultSubagentModel: 'haiku',
      depth: 0,
      childProviderFactory: createChildProviderFactory(),
      agentRegistry: builtinAgents(),
      parentModel: 'sonnet',
      cwd: tmp,
    });
    // No `model` in input — must pick up defaultSubagentModel='haiku'.
    const r = await executor.execute(call('agent', { prompt: 'inspect' }));
    expect(r.isError).toBeFalsy();
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]?.config.model).toBe('haiku');
  },

  // Compose path: node has no explicit model, but defaultSubagentModel='haiku'
  // is set on the context. Before the fix dispatchDagNode used
  // `spec.model ?? 'sonnet'`; now it uses resolveChildModel.
  // Note: compose pre-resolves spec.model via buildComposeDagNode, so the fork
  // receives the resolved model directly. This probe verifies that the resolved
  // model reaches the fork config correctly end-to-end.
  'model-resolution:compose': async () => {
    const executor = new ComposeExecutor({
      parentSession: { sessionId: 'parent-session', abortSignal: new AbortController().signal },
      apiKey: 'test-key',
      systemPrompt: 'base prompt',
      agentRegistry: builtinAgents(),
      defaultSubagentModel: 'haiku',
      resolveApiKeyForModel: () => 'test-key',
      cwd: tmp,
    });
    // No `model` on the node — must pick up defaultSubagentModel='haiku'.
    await executor.execute(
      call('compose', { nodes: [{ id: 'a', prompt: 'inspect the module' }] }),
    );
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]?.config.model).toBe('haiku');
  },

  // Skill-fork path: resolveChildModel is used in fork-dispatch.ts.
  // Probe: defaultSubagentModel='haiku' and no SKILL.md model override →
  // fork receives 'haiku', not 'sonnet'.
  'model-resolution:skill-fork': async () => {
    registerSkill({
      name: 'parity-model-skill',
      description: 'model resolution parity probe skill',
      context: 'fork',
      handler: vi.fn(),
    });
    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'parent-session',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal: new AbortController().signal,
      },
      defaultModel: 'sonnet',
      defaultSubagentModel: 'haiku',
      apiKey: 'test-key',
      cwd: tmp,
      childProviderFactory: createChildProviderFactory(),
      depth: 0,
    });
    const r = await executor.execute(call('skill', { name: 'parity-model-skill' }));
    expect(r.isError).toBeFalsy();
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]?.config.model).toBe('haiku');
  },
};

// Tests

describe('dispatch-policy parity matrix (#4042)', () => {
  it('every (policy, caller) cell has an explicit decision', () => {
    for (const policy of POLICIES) {
      for (const caller of CALLERS) {
        const cell = DISPATCH_POLICY_MATRIX[policy]?.[caller];
        expect(cell, `missing matrix cell ${policy} x ${caller}`).toBeDefined();
        if (cell !== undefined && cell !== 'enforced') {
          const reason = 'na' in cell ? cell.na : cell.gap;
          expect(reason.trim().length, `${policy} x ${caller} needs a reason`).toBeGreaterThan(20);
        }
      }
    }
    expect(Object.keys(DISPATCH_POLICY_MATRIX).sort()).toEqual([...POLICIES].sort());
  });

  it('every enforced cell has a behavioral probe, and every probe backs an enforced cell', () => {
    for (const policy of POLICIES) {
      for (const caller of CALLERS) {
        const key: CellKey = `${policy}:${caller}`;
        const enforced = DISPATCH_POLICY_MATRIX[policy][caller] === 'enforced';
        expect(PROBES[key] !== undefined, `${key}: enforced=${String(enforced)} but probe presence differs`)
          .toBe(enforced);
      }
    }
  });

  for (const policy of POLICIES) {
    for (const caller of CALLERS) {
      const cell = DISPATCH_POLICY_MATRIX[policy][caller];
      const probe = PROBES[`${policy}:${caller}`];
      if (cell === 'enforced' && probe !== undefined) {
        it(`${policy} x ${caller}: enforced`, probe);
      } else if (cell !== 'enforced' && 'gap' in cell && probe !== undefined) {
        // Known fail-open gap: the probe is expected to FAIL until fixed.
        it.fails(`${policy} x ${caller}: GAP ${cell.gap}`, probe);
      }
    }
  }
});
