/**
 * #4073: restricted child providers carry the fork context's workspace store,
 * so a granted `workspace_publish` / `workspace_query` is both advertised and
 * handled. Before the fix none of the restricted builders received a store,
 * so `grantsTool('workspace_publish')` was false on every path below even when
 * the allowlist named the tool.
 *
 * The allowlist stays the authority: a store on a provider whose allowlist
 * omits the workspace tools must still report them as not granted.
 *
 * Covers each builder on both provider routes, then each fork path that calls
 * one: agent tool at the depth cap, skill fork at the cap (read-only and
 * `tools:`-restricted). The `phaseRole: 'read-only'` path is pinned in
 * `subagent/fork-child-config.workspace-grant.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'resolved-test-credential'),
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHILD_ALLOWED_TOOLS,
  buildPhaseRestrictedProvider,
  buildReadOnlyReconProvider,
  buildSkillRestrictedProvider,
} from './nesting.js';
import { resolveAgentToolAccess } from '../agents/index.js';
import { parseSkillMetadata } from '../plugins/tool-injector.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';
import { buildChildConfig, type BuildChildConfigArgs } from './subagent/child-config.js';
import { SkillExecutor } from './skill-executor.js';
import { SubagentManager } from '../subagent.js';
import type { PluginSkillBody } from './skill-bridge.js';
import type { ModelProvider } from '../provider.js';
import type { RegisteredAgent } from '../agents/index.js';
import type { SubagentExecutor } from './subagent-executor.js';

const WS_TOOLS = ['workspace_publish', 'workspace_query'];
const ROUTES = [
  ['anthropic-direct', 'sonnet'],
  ['openai-compatible', 'gpt-4o'],
] as const;

function grants(provider: ModelProvider | undefined): { publish: boolean; query: boolean } {
  return {
    publish: provider?.grantsTool?.('workspace_publish') ?? false,
    query: provider?.grantsTool?.('workspace_query') ?? false,
  };
}

describe.each(ROUTES)('restricted builders carry the workspace store (%s route)', (_route, model) => {
  it('buildSkillRestrictedProvider grants workspace tools for a granted allowlist + store', () => {
    const p = buildSkillRestrictedProvider(['read_file', ...WS_TOOLS], model, false, undefined, new WorkspaceStore());
    expect(grants(p)).toEqual({ publish: true, query: true });
  });

  it('buildSkillRestrictedProvider grants nothing when the allowlist omits the workspace tools', () => {
    const p = buildSkillRestrictedProvider(['read_file'], model, false, undefined, new WorkspaceStore());
    expect(grants(p)).toEqual({ publish: false, query: false });
  });

  it('buildReadOnlyReconProvider grants the RECON workspace tools when given a store', () => {
    const p = buildReadOnlyReconProvider(model, undefined, undefined, new WorkspaceStore());
    expect(grants(p)).toEqual({ publish: true, query: true });
  });

  it('buildReadOnlyReconProvider grants nothing for a declared subset without workspace tools', () => {
    const p = buildReadOnlyReconProvider(model, undefined, ['read_file', 'grep'], new WorkspaceStore());
    expect(grants(p)).toEqual({ publish: false, query: false });
  });

  it('buildPhaseRestrictedProvider grants the READ_ONLY_PHASE workspace tools when given a store', () => {
    const p = buildPhaseRestrictedProvider('read-only', model, new WorkspaceStore());
    expect(grants(p)).toEqual({ publish: true, query: true });
  });

  it('every builder grants nothing without a store (AFK_WORKSPACE_DISABLED)', () => {
    expect(grants(buildSkillRestrictedProvider(['read_file', ...WS_TOOLS], model))).toEqual({ publish: false, query: false });
    expect(grants(buildReadOnlyReconProvider(model))).toEqual({ publish: false, query: false });
    expect(grants(buildPhaseRestrictedProvider('read-only', model))).toEqual({ publish: false, query: false });
  });
});

describe('`tools:` vocabularies accept the workspace tools', () => {
  it('a named agent can declare them (no longer dropped as unknown tokens)', () => {
    const access = resolveAgentToolAccess(
      { name: 'a', source: 'user', definition: { description: 'd', prompt: 'p', tools: ['read_file', ...WS_TOOLS] } },
      CHILD_ALLOWED_TOOLS,
    );
    expect(access.allowedTools).toEqual(['read_file', ...WS_TOOLS]);
    expect(access.droppedTokens).toEqual([]);
  });

  it('a plugin skill can declare them in `tools:` frontmatter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-tools-skill-'));
    try {
      const path = join(dir, 'SKILL.md');
      writeFileSync(path, '---\nname: ws-skill\ndescription: d\ntools: read_file, workspace_publish, workspace_query\n---\nbody\n');
      expect(parseSkillMetadata(path).allowedTools).toEqual(['read_file', ...WS_TOOLS]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('agent tool at the depth cap (wireChildNesting fallback)', () => {
  function namedAgent(tools: string[]): RegisteredAgent {
    return { name: 'ws-agent', source: 'user', definition: { description: 'd', prompt: 'p', tools } };
  }

  function capArgs(tools: string[], workspaceStore: WorkspaceStore | undefined): BuildChildConfigArgs {
    return {
      parsed: {
        prompt: 'do the thing', max_turns: 10, max_turns_explicit: false,
        max_tool_use_iterations: 0, max_tool_use_iterations_explicit: false,
        id_prefix: 'agent-tool', mode: 'foreground',
      },
      namedAgent: namedAgent(tools),
      depth: 3,
      maxDepth: 3,
      currentCwd: undefined,
      signal: new AbortController().signal,
      defaultConfig: {
        apiKey: 'k', systemPrompt: 'base', baseUrl: undefined, openaiBaseUrl: undefined, xaiBaseUrl: undefined,
      },
      resolveApiKeyForModel: vi.fn(() => 'child-key'),
      createChildExecutor: vi.fn(() => ({}) as unknown as SubagentExecutor),
      defaultSubagentModel: 'sonnet',
      ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    };
  }

  it('a named agent that declares the workspace tools keeps them at the cap', () => {
    const { childConfig } = buildChildConfig(capArgs(['read_file', ...WS_TOOLS], new WorkspaceStore()));
    expect(grants(childConfig.provider)).toEqual({ publish: true, query: true });
  });

  it('a named agent that does not declare them is not granted them, store or not', () => {
    const { childConfig } = buildChildConfig(capArgs(['read_file'], new WorkspaceStore()));
    expect(grants(childConfig.provider)).toEqual({ publish: false, query: false });
  });

  it('no store in the fork context means no workspace tools', () => {
    const { childConfig } = buildChildConfig(capArgs(['read_file', ...WS_TOOLS], undefined));
    expect(grants(childConfig.provider)).toEqual({ publish: false, query: false });
  });
});

describe('skill fork at the depth cap (buildForkedChildConfig fallback)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function forkedProvider(body: PluginSkillBody, workspaceStore: WorkspaceStore | undefined): Promise<ModelProvider | undefined> {
    const fork = vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockResolvedValue({
      runToResult: vi.fn().mockResolvedValue({ status: 'succeeded', message: { content: 'ok' } }),
      teardown: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
    // No childProviderFactory: buildForkedChildConfig takes the cap/no-factory branch.
    const executor = new SkillExecutor({
      parentSession: { sessionId: 's', getInputStreamRef: () => ({ pushUserMessage: () => {} }), abortSignal: new AbortController().signal },
      defaultModel: 'sonnet',
      defaultSubagentModel: 'sonnet',
      ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    });
    (executor as unknown as { pluginBodies: Map<string, PluginSkillBody> | null }).pluginBodies = new Map([['ws-skill', body]]);
    const result = await executor.execute({ id: 'c', name: 'skill', input: { name: 'ws-skill' }, signal: new AbortController().signal });
    expect(result.isError).toBeUndefined();
    const forkArgs = fork.mock.calls[0]?.[0] as { config?: { provider?: ModelProvider } } | undefined;
    return forkArgs?.config?.provider;
  }

  it('a read-only skill (full RECON set) gets the workspace tools', async () => {
    const provider = await forkedProvider({ body: 'b', pluginPath: '/p', context: 'fork', readOnly: true }, new WorkspaceStore());
    expect(grants(provider)).toEqual({ publish: true, query: true });
  });

  it('a tools:-restricted skill that declares the workspace tools gets them', async () => {
    const provider = await forkedProvider(
      { body: 'b', pluginPath: '/p', context: 'fork', allowedTools: ['read_file', ...WS_TOOLS] },
      new WorkspaceStore(),
    );
    expect(grants(provider)).toEqual({ publish: true, query: true });
  });

  it('a tools:-restricted skill that omits them does not get them', async () => {
    const provider = await forkedProvider(
      { body: 'b', pluginPath: '/p', context: 'fork', allowedTools: ['read_file'] },
      new WorkspaceStore(),
    );
    expect(grants(provider)).toEqual({ publish: false, query: false });
  });
});
