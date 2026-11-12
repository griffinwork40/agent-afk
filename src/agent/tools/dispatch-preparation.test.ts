import { describe, expect, it, vi } from 'vitest';

vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'fresh-default-key'),
}));

import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import { defaultTierModelFallback } from '../subagent/resolve-child-model.js';
import { prepareDispatchModel, type DispatchCredentialPolicy } from './dispatch-preparation.js';
import { buildChildConfigWithoutNesting, type BuildChildConfigArgs } from './subagent/child-config.js';
import { buildComposeDagNode, type BuildComposeDagNodeArgs } from './compose-executor.node-build.js';
import type { SubagentDAGNode } from '../dag-subagent.js';

const policies: DispatchCredentialPolicy[] = ['skip-openai-resolution', 'resolve-then-omit-openai'];

function agentArgs(model: string | undefined, resolver: (model: string) => string | undefined): BuildChildConfigArgs {
  return {
    parsed: {
      prompt: 'inspect dispatch', model, max_turns: 0, max_turns_explicit: false,
      max_tool_use_iterations: 0, max_tool_use_iterations_explicit: false,
      id_prefix: 'test', mode: 'foreground',
    },
    namedAgent: undefined, depth: 0, maxDepth: 0, currentCwd: undefined,
    signal: new AbortController().signal,
    defaultConfig: { apiKey: 'sk-ant-parent' },
    defaultSubagentModel: 'sonnet', parentModel: 'opus',
    resolveApiKeyForModel: resolver,
    createChildExecutor: () => { throw new Error('nesting is outside this preparation stage'); },
  };
}

function composeArgs(model: string | undefined, resolver: (model: string) => string | undefined): BuildComposeDagNodeArgs {
  return {
    node: { id: 'inspect', prompt: 'inspect dispatch', ...(model !== undefined ? { model } : {}) },
    index: 0, resolvedAgent: {}, totalNodes: 1, composeToolUseId: 'compose-test',
    ctx: {
      parentSession: { sessionId: 'parent', abortSignal: new AbortController().signal },
      defaultSubagentModel: 'sonnet', defaultModel: 'opus', systemPrompt: 'worker',
      apiKey: 'sk-ant-parent', resolveApiKeyForModel: resolver,
    },
    currentCwd: undefined, nodeReadRoots: undefined, maxToolRoundsPerNode: undefined,
    depth: 0, maxDepth: 0,
  };
}

async function composeNode(args: BuildComposeDagNodeArgs): Promise<SubagentDAGNode> {
  const result = await buildComposeDagNode(args);
  if ('attachmentError' in result) throw result.error;
  return result;
}

describe('shared dispatch model preparation (#4042)', () => {
  it.each(policies)('%s resolves intent and retains its provenance for default-only fallback', (credentialPolicy) => {
    const resolveApiKeyForModel = vi.fn(() => 'fresh');
    const intent = { callSiteModel: 'haiku', namedAgentModel: 'opus', defaultSubagentModel: 'sonnet', defaultModel: 'haiku' };
    const explicit = prepareDispatchModel({ modelIntent: intent, credentialPolicy, resolveApiKeyForModel });
    expect(explicit).toMatchObject({ model: 'haiku', source: 'callSite', apiKey: 'fresh' });
    expect(defaultTierModelFallback(explicit, 'opus')).toBeUndefined();
    const named = prepareDispatchModel({ modelIntent: { ...intent, callSiteModel: undefined }, credentialPolicy, resolveApiKeyForModel });
    expect(named.source).toBe('namedAgent');
    expect(defaultTierModelFallback(named, 'haiku')).toBeUndefined();
    const policy = prepareDispatchModel({ modelIntent: { defaultSubagentModel: 'sonnet', defaultModel: 'opus' }, credentialPolicy, resolveApiKeyForModel });
    expect(policy.source).toBe('default');
    expect(defaultTierModelFallback(policy, 'opus')).toEqual({ model: 'opus' });
    const parent = prepareDispatchModel({ modelIntent: { defaultModel: 'opus' }, credentialPolicy, resolveApiKeyForModel });
    expect(parent).toMatchObject({ model: 'opus', source: 'parent' });
    expect(defaultTierModelFallback(parent, 'haiku')).toBeUndefined();
    const floor = prepareDispatchModel({ modelIntent: {}, credentialPolicy, resolveApiKeyForModel });
    expect(floor).toMatchObject({ model: 'sonnet', source: 'floor' });
  });

  it.each(policies)('%s refreshes each invocation, falling back only to an Anthropic-shaped parent', (credentialPolicy) => {
    const resolver = vi.fn<() => string | undefined>().mockReturnValueOnce('fresh-one').mockReturnValueOnce('fresh-two').mockReturnValue(undefined);
    const input = { modelIntent: { callSiteModel: 'sonnet' }, credentialPolicy, resolveApiKeyForModel: resolver, parentApiKey: 'sk-ant-parent' };
    expect(prepareDispatchModel(input).apiKey).toBe('fresh-one');
    expect(prepareDispatchModel(input).apiKey).toBe('fresh-two');
    expect(prepareDispatchModel(input).apiKey).toBe('sk-ant-parent');
    expect(prepareDispatchModel({ ...input, parentApiKey: 'sk-proj-foreign' }).apiKey).toBeUndefined();
  });

  it('uses the live default resolver when none is injected, except for compose OpenAI nodes', () => {
    vi.mocked(resolveCredentialForModel).mockClear();
    expect(prepareDispatchModel({ modelIntent: { callSiteModel: 'sonnet' }, credentialPolicy: 'skip-openai-resolution' }).apiKey).toBe('fresh-default-key');
    expect(resolveCredentialForModel).toHaveBeenCalledExactlyOnceWith('sonnet');
    prepareDispatchModel({ modelIntent: { callSiteModel: 'gpt-4o' }, credentialPolicy: 'skip-openai-resolution' });
    expect(resolveCredentialForModel).toHaveBeenCalledTimes(1);
  });

  it('preserves compose early exit even when the supplied resolver would throw', async () => {
    const resolver = vi.fn(() => { throw new Error('must not resolve an OpenAI compose key'); });
    const node = await composeNode(composeArgs('gpt-4o', resolver));
    expect(node.model).toBe('gpt-4o');
    expect(node.apiKey).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('preserves agent resolver invocation but discards even a misconfigured Anthropic key for OpenAI', () => {
    const resolver = vi.fn(() => 'sk-ant-must-not-leak');
    const { childConfig } = buildChildConfigWithoutNesting(agentArgs('gpt-4o', resolver));
    expect(resolver).toHaveBeenCalledExactlyOnceWith('gpt-4o');
    expect(childConfig.model).toBe('gpt-4o');
    expect(childConfig.apiKey).toBeUndefined();
    expect(childConfig.baseUrl).toBeUndefined();
  });

  it('retains agent resolver failures rather than silently skipping them for OpenAI', () => {
    const resolver = () => { throw new Error('resolver unavailable'); };
    expect(() => buildChildConfigWithoutNesting(agentArgs('gpt-4o', resolver))).toThrow('resolver unavailable');
  });

  it('both callers resolve credentials against the selected model, not the parent model', async () => {
    const resolver = vi.fn((m: string) => `key-for-${m}`);
    const agent = buildChildConfigWithoutNesting(agentArgs('haiku', resolver));
    const node = await composeNode(composeArgs('haiku', resolver));
    expect(agent.childConfig.apiKey).toBe('key-for-haiku');
    expect(node.apiKey).toBe('key-for-haiku');
    expect(agent.childModelSource).toBe('callSite');
    expect(resolver.mock.calls).toEqual([['haiku'], ['haiku']]);
  });

  it('both callers preserve fallback and refuse a foreign parent key when fresh resolution is empty', async () => {
    const resolver = () => undefined;
    const agent = agentArgs('sonnet', resolver);
    const compose = composeArgs('sonnet', resolver);
    expect(buildChildConfigWithoutNesting(agent).childConfig.apiKey).toBe('sk-ant-parent');
    expect((await composeNode(compose)).apiKey).toBe('sk-ant-parent');
    agent.defaultConfig.apiKey = 'sk-proj-foreign';
    compose.ctx.apiKey = 'sk-proj-foreign';
    expect(buildChildConfigWithoutNesting(agent).childConfig.apiKey).toBeUndefined();
    expect((await composeNode(compose)).apiKey).toBeUndefined();
  });

  it('retains caller-specific parent-model intent and named inherit semantics', async () => {
    const resolver = () => 'fresh';
    const agent = agentArgs(undefined, resolver);
    const compose = composeArgs(undefined, resolver);
    // The agent default is required in production; absence here exercises its
    // historical floor vs. compose's optional parent safety net.
    agent.defaultSubagentModel = undefined as unknown as typeof agent.defaultSubagentModel;
    compose.ctx.defaultSubagentModel = undefined as unknown as typeof compose.ctx.defaultSubagentModel;
    expect(buildChildConfigWithoutNesting(agent).childConfig.model).toBe('sonnet');
    expect((await composeNode(compose)).model).toBe('opus');
    agent.namedAgent = { name: 'inherited', source: 'user', definition: { description: 'test', prompt: 'worker', model: 'inherit' } };
    expect(buildChildConfigWithoutNesting(agent)).toMatchObject({ childConfig: { model: 'opus' }, childModelSource: 'namedAgent' });
    agent.parsed.model = 'haiku';
    expect(buildChildConfigWithoutNesting(agent)).toMatchObject({ childConfig: { model: 'haiku' }, childModelSource: 'callSite' });
  });
});
