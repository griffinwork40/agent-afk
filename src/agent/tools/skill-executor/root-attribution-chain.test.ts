/**
 * #2442: nested fork chains that pass through a SKILL fork must still credit
 * grandchild commits to the depth-0 root session.
 *
 * Drives the real dispatch chain end to end:
 *   SkillExecutor / SubagentExecutor (real)
 *     → buildForkedChildConfig / buildChildConfig (real)
 *     → createChildSkillExecutorFactory (real, nesting.ts)
 *     → SubagentManager.forkSubagent (STUBBED: assembles the child config via
 *       the real `assembleChildConfig` with the manager's real parent fields,
 *       then returns a handle whose `runToResult` dispatches the next hop
 *       through the executors the real wiring handed the child provider)
 *     → createChildAttributionHook (real) fed the grandchild's config ids.
 *
 * Only the model round-trip is faked; every id the hook sees is produced by
 * production wiring. Before the fix both chains stamped no root id and no
 * parent id on the skill-side hop, so the hook returned early.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'k'),
  loadAnthropicCredential: vi.fn(() => 'k'),
  loadOpenAICredential: vi.fn(() => undefined),
}));
const appendArtifactsSpy = vi.hoisted(() => vi.fn());
vi.mock('../../outcomes/store.js', () => ({ appendArtifacts: appendArtifactsSpy }));

import { SkillExecutor } from '../skill-executor.js';
import { SubagentExecutor } from '../subagent-executor.js';
import { SubagentManager } from '../../subagent.js';
import { assembleChildConfig } from '../../subagent/fork-child-config.js';
import type { ForkSubagentOptions } from '../../subagent/fork-types.js';
import { createChildSkillExecutorFactory, type ChildProviderFactoryArgs } from '../nesting.js';
import { createChildAttributionHook } from '../../outcomes/child-attribution.js';
import { registerSkill, _resetRegistry } from '../../../skills/skill-registry.js';
import * as promptLoader from '../../../skills/_lib/prompt-loader.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { ModelProvider } from '../../provider.js';

const ROOT = 'root-sess';

interface Fork { id: string; parentSessionId: string | undefined; config: AgentConfig }

/** Executors the real wiring handed to the most recent child provider. */
let pending: { childExecutor?: SubagentExecutor; childSkillExecutor?: SkillExecutor } = {};
const childProviderFactory = (args: ChildProviderFactoryArgs): ModelProvider => {
  pending = {
    childExecutor: args.childExecutor as SubagentExecutor,
    ...(args.childSkillExecutor !== undefined ? { childSkillExecutor: args.childSkillExecutor as SkillExecutor } : {}),
  };
  return { name: 'stub', query: vi.fn() } as unknown as ModelProvider;
};

/**
 * Stub forkSubagent: real config assembly, then run `next` (the following hop)
 * with the executors wired for THIS child, mimicking the child model calling a tool.
 */
function armForks(next: (forkIndex: number, exec: typeof pending) => Promise<void>): Fork[] {
  const forks: Fork[] = [];
  vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(async function (
    this: SubagentManager,
    options: ForkSubagentOptions<unknown>,
  ) {
    const id = `${options.idPrefix ?? 'subagent'}-${forks.length + 1}`;
    const fields = (this as unknown as { parentForkFields: () => object }).parentForkFields();
    const config = assembleChildConfig({
      options, id, resume: options.parent.sessionId, registry: undefined,
      effectiveChildModel: 'claude-sonnet-5', effectiveTimeoutMs: 30_000,
      inheritedReadRoots: undefined, composedWriteRoots: undefined,
      childController: new AbortController(),
      ...(fields as Pick<Parameters<typeof assembleChildConfig>[0], 'parentCwd'>),
    } as Parameters<typeof assembleChildConfig>[0]);
    const index = forks.length;
    forks.push({ id, parentSessionId: options.parent.sessionId, config });
    const exec = pending;
    return {
      id, status: 'succeeded', session: undefined,
      runToResult: vi.fn(async () => {
        await next(index, exec);
        return { id, status: 'succeeded', message: { role: 'assistant', content: 'done', timestamp: new Date() } };
      }),
      cancel: vi.fn(), teardown: vi.fn().mockResolvedValue(undefined),
      getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
    } as unknown as Awaited<ReturnType<SubagentManager['forkSubagent']>>;
  });
  vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
  return forks;
}

const signal = new AbortController().signal;
const rootParent = { sessionId: ROOT, getInputStreamRef: () => ({ pushUserMessage: () => {} }), abortSignal: signal };
const skillFactory = createChildSkillExecutorFactory('sonnet', 'k', childProviderFactory);

async function creditedTo(grandchild: Fork): Promise<string | undefined> {
  appendArtifactsSpy.mockClear();
  createChildAttributionHook()({
    event: 'PostToolUse', toolName: 'bash', sessionId: grandchild.id,
    parentSessionId: grandchild.config.parentSessionId, rootSessionId: grandchild.config.rootSessionId,
    output: '[main abc1234] fix: grandchild commit',
  } as never);
  await new Promise((r) => setTimeout(r, 10));
  return appendArtifactsSpy.mock.calls[0]?.[0] as string | undefined;
}

describe('#2442 root attribution through skill-fork chains', () => {
  beforeEach(() => {
    _resetRegistry();
    pending = {};
    registerSkill({ name: 'probe', context: 'fork', handler: vi.fn() });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'You are a probe skill.' });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('root → skill(fork) → agent: grandchild carries the root id and its commit is credited to root', async () => {
    const forks = armForks(async (i, exec) => {
      if (i === 0) await exec.childExecutor!.execute({ id: 'agent-call', name: 'agent', input: { prompt: 'commit' }, signal });
    });
    const root = new SkillExecutor({
      parentSession: rootParent, defaultModel: 'sonnet', defaultSubagentModel: 'sonnet', apiKey: 'k',
      depth: 0, maxDepth: 3, childProviderFactory, childSkillExecutorFactory: skillFactory,
    });
    const res = await root.execute({ id: 'skill-call', name: 'skill', input: { name: 'probe' }, signal });
    expect(res.isError).not.toBe(true);

    expect(forks).toHaveLength(2);
    const [skillChild, grandchild] = forks as [Fork, Fork];
    expect(skillChild.config.parentSessionId).toBe(ROOT);
    expect(skillChild.config.rootSessionId).toBe(ROOT);
    // The skill child's executor stub was backfilled with its real id.
    expect(grandchild.parentSessionId).toBe(skillChild.id);
    expect(grandchild.config.parentSessionId).toBe(skillChild.id);
    expect(grandchild.config.rootSessionId).toBe(ROOT);
    expect(await creditedTo(grandchild)).toBe(ROOT);
  });

  it('root → agent → skill(fork): skill child carries a real parent id and the root id', async () => {
    const forks = armForks(async (i, exec) => {
      if (i === 0) await exec.childSkillExecutor!.execute({ id: 'nested-skill', name: 'skill', input: { name: 'probe' }, signal });
    });
    const root = new SubagentExecutor({
      subagentManager: new SubagentManager({ parentAbortSignal: signal }),
      parentSession: rootParent,
      defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
      defaultSubagentModel: 'sonnet', childProviderFactory, childSkillExecutorFactory: skillFactory,
      depth: 0, maxDepth: 3,
    });
    const res = await root.execute({ id: 'agent-call', name: 'agent', input: { prompt: 'run probe' }, signal });
    expect(res.isError).not.toBe(true);

    expect(forks).toHaveLength(2);
    const [agentChild, skillChild] = forks as [Fork, Fork];
    expect(agentChild.config.rootSessionId).toBe(ROOT);
    expect(skillChild.parentSessionId).toBe(agentChild.id);
    expect(skillChild.config.parentSessionId).toBe(agentChild.id);
    expect(skillChild.config.rootSessionId).toBe(ROOT);
    expect(await creditedTo(skillChild)).toBe(ROOT);
  });
});
