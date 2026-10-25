/**
 * Integration test for #4060: a forked child whose effective tool surface
 * excludes the workspace tools must not be told to call them.
 *
 * Unmocked on purpose: it runs the real `assembleChildConfig`, the real
 * restricted-provider builders from `tools/nesting.ts` (the same ones the
 * agent tool, skill forks and `phaseRole: 'read-only'` use), and the real
 * workspace preamble, so it pins the whole chain from the provider's grant to
 * the child's system prompt.
 */

import { describe, it, expect } from 'vitest';
import { assembleChildConfig, type AssembleChildConfigArgs } from './fork-child-config.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';
import { buildSkillRestrictedProvider } from '../tools/nesting.js';
import type { ModelProvider } from '../provider.js';

function makeArgs(
  provider: ModelProvider | undefined,
  workspaceStore: WorkspaceStore,
  extra: { options?: AssembleChildConfigArgs<unknown>['options'] } = {},
): AssembleChildConfigArgs<unknown> {
  return {
    options: {
      parent: { sessionId: 'parent-sess' },
      config: { model: 'local', systemPrompt: 'Investigate git history.', ...(provider ? { provider } : {}) },
      agentType: 'git-investigator',
    },
    id: 'child-id',
    resume: undefined,
    registry: undefined,
    effectiveChildModel: 'local',
    effectiveTimeoutMs: 30_000,
    inheritedReadRoots: undefined,
    composedWriteRoots: undefined,
    childController: new AbortController(),
    parentCwd: undefined,
    parentApiKey: undefined,
    parentBaseUrl: undefined,
    parentProvider: undefined,
    parentTraceWriter: undefined,
    parentSurface: undefined,
    parentCanUseTool: undefined,
    parentRootSessionId: undefined,
    workspaceStore,
    ...extra,
  };
}

function systemPromptOf(cfg: { systemPrompt?: unknown }): string {
  return typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : JSON.stringify(cfg.systemPrompt ?? '');
}

const READ_ONLY_TOOLS = ['bash', 'Read', 'Grep', 'Glob'];

describe('assembleChildConfig workspace preamble follows the child grant (#4060)', () => {
  it('gives a read-only named child (no store on its provider) no workspace instructions', () => {
    const provider = buildSkillRestrictedProvider(READ_ONLY_TOOLS, 'local', true);
    const cfg = assembleChildConfig(makeArgs(provider, new WorkspaceStore()));
    const prompt = systemPromptOf(cfg);
    expect(prompt).not.toContain('workspace_publish');
    expect(prompt).not.toContain('workspace_query');
    expect(cfg.hasWorkspacePreamble).toBeUndefined();
  });

  it('still shows sibling findings to that child, without tool instructions', () => {
    const store = new WorkspaceStore();
    store.publish({ session_id: 's', type: 'finding', content: 'Investigate git history: HEAD is pinned.' });
    const provider = buildSkillRestrictedProvider(READ_ONLY_TOOLS, 'local', true);
    const cfg = assembleChildConfig(makeArgs(provider, store));
    const prompt = systemPromptOf(cfg);
    expect(prompt).toContain('HEAD is pinned.');
    expect(prompt).not.toContain('workspace_publish');
    expect(cfg.hasWorkspacePreamble).toBe(true);
  });

  // #4073: the phase provider now carries the fork store, and
  // READ_ONLY_PHASE_TOOLS grants both workspace tools on purpose, so the child
  // both holds the tools and is told to use them.
  it('tells a phaseRole read-only child to use the workspace tools its phase grants', () => {
    const cfg = assembleChildConfig(makeArgs(undefined, new WorkspaceStore(), {
      options: {
        parent: { sessionId: 'parent-sess' },
        config: { model: 'local', systemPrompt: 'Investigate.' },
        agentType: 'recon',
        phaseRole: 'read-only',
      },
    }));
    expect(cfg.provider?.grantsTool?.('workspace_publish')).toBe(true);
    expect(cfg.provider?.grantsTool?.('workspace_query')).toBe(true);
    expect(systemPromptOf(cfg)).toContain('Call `workspace_publish` when you:');
    expect(cfg.hasWorkspacePreamble).toBe(true);
  });

  it('gives a phaseRole read-only child no workspace tools when workspace is disabled (no store)', () => {
    const args = makeArgs(undefined, new WorkspaceStore(), {
      options: {
        parent: { sessionId: 'parent-sess' },
        config: { model: 'local', systemPrompt: 'Investigate.' },
        agentType: 'recon',
        phaseRole: 'read-only',
      },
    });
    const cfg = assembleChildConfig({ ...args, workspaceStore: undefined });
    expect(cfg.provider?.grantsTool?.('workspace_publish')).toBe(false);
    expect(systemPromptOf(cfg)).not.toContain('workspace_publish');
  });

  it('tells a child that holds the workspace tools to use them', () => {
    const store = new WorkspaceStore();
    const provider = buildSkillRestrictedProvider(
      [...READ_ONLY_TOOLS, 'workspace_publish', 'workspace_query'], 'local', true, undefined, store,
    );
    const cfg = assembleChildConfig(makeArgs(provider, store));
    expect(systemPromptOf(cfg)).toContain('Call `workspace_publish` when you:');
    expect(cfg.hasWorkspacePreamble).toBe(true);
  });

  it('keeps the legacy hint for a child with no provider (grant unknown)', () => {
    const cfg = assembleChildConfig(makeArgs(undefined, new WorkspaceStore()));
    expect(systemPromptOf(cfg)).toContain('If `workspace_publish` is available');
  });
});
