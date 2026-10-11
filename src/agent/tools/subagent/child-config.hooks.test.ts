/**
 * #3442: a `hookRegistry` on the executor context reaches the nested managers
 * built with stub parents (which carry no registry), at every depth:
 *   - agent-tool depth 2+: buildChildConfig → buildNestedChildManager,
 *     and the recursive child executor ctx (chain holds to maxDepth);
 *   - SubagentExecutor.inheritedChildConfigArgs forwards ctx.hookRegistry;
 *   - skill forks: fork-dispatch buildSkillForkManager (per-call manager);
 *   - skill-child `agent` forks: fork-child-config buildSkillChildManager.
 * Asserted on the manager's resolved registry (the field fork-resolution.ts
 * reads as `managerHookRegistry` when dispatching SubagentStart/Stop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'k' as string | undefined),
  loadAnthropicCredential: vi.fn(() => 'k'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

import { createHookRegistry, type HookRegistry } from '../../hooks.js';
import { buildChildConfig } from './child-config.js';
import { SubagentExecutor, type SubagentExecutorContext } from '../subagent-executor.js';
import { SubagentManager } from '../../subagent.js';
import { SkillExecutor } from '../skill-executor.js';
import { buildForkedChildConfig } from '../skill-executor/fork-child-config.js';
import { registerSkill, _resetRegistry } from '../../../skills/skill-registry.js';
import * as promptLoader from '../../../skills/_lib/prompt-loader.js';
import type { ModelProvider } from '../../provider.js';

const signal = new AbortController().signal;
const registryOf = (m: unknown): HookRegistry | undefined =>
  (m as { hookRegistry: HookRegistry | undefined }).hookRegistry;
const parentSession = {
  sessionId: 'root',
  getInputStreamRef: () => ({ pushUserMessage: () => {} }),
  abortSignal: signal,
};
const provider = (): ModelProvider => ({}) as unknown as ModelProvider;

function agentArgs(hooks: HookRegistry | undefined, capture: (c: SubagentExecutorContext) => void) {
  return {
    parsed: {
      prompt: 'p', max_turns: 10, max_turns_explicit: false, max_tool_use_iterations: 0,
      max_tool_use_iterations_explicit: false, id_prefix: 'agent-tool', mode: 'foreground' as const,
    },
    namedAgent: undefined, depth: 1, maxDepth: 4, currentCwd: undefined, signal,
    defaultConfig: { apiKey: 'k', systemPrompt: 's' },
    resolveApiKeyForModel: () => 'k',
    defaultSubagentModel: 'sonnet',
    childProviderFactory: vi.fn(provider),
    createChildExecutor: (c: SubagentExecutorContext) => { capture(c); return {} as unknown as SubagentExecutor; },
    ...(hooks !== undefined ? { hookRegistry: hooks } : {}),
  };
}

describe('hookRegistry reaches nested managers (#3442)', () => {
  beforeEach(() => _resetRegistry());
  afterEach(() => vi.restoreAllMocks());

  it('agent-tool depth 2+: nested manager + recursive child executor ctx', () => {
    const hooks = createHookRegistry();
    let childCtx: SubagentExecutorContext | undefined;
    const { childManager } = buildChildConfig(agentArgs(hooks, (c) => { childCtx = c; }));
    expect(registryOf(childManager)).toBe(hooks);
    expect(childCtx?.hookRegistry).toBe(hooks);
  });

  it('agent-tool: absent hookRegistry stays absent (byte-identical)', () => {
    let childCtx: SubagentExecutorContext | undefined;
    const { childManager } = buildChildConfig(agentArgs(undefined, (c) => { childCtx = c; }));
    expect(registryOf(childManager)).toBeUndefined();
    expect(childCtx).not.toHaveProperty('hookRegistry');
  });

  it('SubagentExecutor forwards ctx.hookRegistry into buildChildConfig args', () => {
    const hooks = createHookRegistry();
    const exec = new SubagentExecutor({
      subagentManager: new SubagentManager(), parentSession, defaultConfig: {},
      defaultSubagentModel: 'sonnet', depth: 0, maxDepth: 3, hookRegistry: hooks,
    } as unknown as SubagentExecutorContext);
    const inherited = (exec as unknown as { inheritedChildConfigArgs(): { hookRegistry?: HookRegistry } })
      .inheritedChildConfigArgs();
    expect(inherited.hookRegistry).toBe(hooks);
  });

  it('skill fork per-call manager (fork-dispatch) carries the registry', async () => {
    const hooks = createHookRegistry();
    registerSkill({ name: 'fork-skill', description: 't', context: 'fork', handler: vi.fn() });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'x' });
    let captured: HookRegistry | undefined;
    vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(async function (this: SubagentManager) {
      captured = registryOf(this);
      return {
        id: 'child',
        runToResult: vi.fn().mockResolvedValue({ status: 'succeeded', message: { content: 'ok' } }),
        teardown: vi.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<SubagentManager['forkSubagent']>>;
    });
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
    const exec = new SkillExecutor({ parentSession, defaultModel: 'sonnet', defaultSubagentModel: 'sonnet', hookRegistry: hooks });
    const r = await exec.execute({ id: 'c', name: 'skill', input: { name: 'fork-skill' }, signal });
    expect(r.isError).toBeUndefined();
    expect(captured).toBe(hooks);
  });

  it('skill-child `agent` fork manager (fork-child-config) + grandchild executor ctx', () => {
    const hooks = createHookRegistry();
    const { childManager } = buildForkedChildConfig(
      {
        ctx: {
          parentSession, defaultModel: 'sonnet', defaultSubagentModel: 'sonnet', depth: 0, maxDepth: 3,
          childProviderFactory: vi.fn(provider), hookRegistry: hooks,
        },
        currentCwd: undefined,
      },
      { model: 'sonnet' },
      signal,
    );
    expect(registryOf(childManager)).toBe(hooks);
  });
});
