/**
 * Tests for the provider-side tool-grant answers (#4060): the shared helpers
 * and both providers' `grantsTool`, which must agree with what each provider's
 * dispatcher actually enforces (permission gate + store-backed registration).
 */

import { describe, it, expect } from 'vitest';
import { providerGrantsTool, grantsWorkspacePrompt } from './tool-grant.js';
import { WorkspaceStore } from '../../workspace/workspace-store.js';
import { AnthropicDirectProvider } from '../anthropic-direct/index.js';
import { OpenAICompatibleProvider } from '../openai-compatible/index.js';
import { XaiProvider } from '../xai/index.js';
import type { ModelProvider } from '../../provider.js';

const READ_ONLY = { allowedTools: ['Read', 'Grep', 'Glob', 'bash'] };
const WITH_WORKSPACE = { allowedTools: ['Read', 'workspace_publish', 'workspace_query'] };

describe('providerGrantsTool', () => {
  it('refuses store-backed workspace tools when there is no store, even if allowlisted', () => {
    expect(providerGrantsTool('workspace_publish', WITH_WORKSPACE, false)).toBe(false);
    expect(providerGrantsTool('workspace_query', undefined, false)).toBe(false);
  });

  it('refuses a workspace tool the allowlist excludes, even with a store', () => {
    expect(providerGrantsTool('workspace_publish', READ_ONLY, true)).toBe(false);
  });

  it('grants a workspace tool when allowlisted and a store is present', () => {
    expect(providerGrantsTool('workspace_publish', WITH_WORKSPACE, true)).toBe(true);
  });

  it('grants everything to an unrestricted provider with a store', () => {
    expect(providerGrantsTool('workspace_query', undefined, true)).toBe(true);
  });

  it('applies the operator deny list', () => {
    expect(providerGrantsTool('workspace_publish', { deniedTools: ['workspace_publish'] }, true)).toBe(false);
  });

  it('does not require a store for non-workspace tools', () => {
    expect(providerGrantsTool('Read', READ_ONLY, false)).toBe(true);
    expect(providerGrantsTool('Write', READ_ONLY, false)).toBe(false);
  });
});

describe('grantsWorkspacePrompt', () => {
  it('requires both workspace_publish and workspace_query', () => {
    expect(grantsWorkspacePrompt(() => true)).toBe(true);
    expect(grantsWorkspacePrompt((t) => t !== 'workspace_query')).toBe(false);
    expect(grantsWorkspacePrompt((t) => t !== 'workspace_publish')).toBe(false);
  });
});

describe.each([
  ['anthropic-direct', (opts: object): ModelProvider => new AnthropicDirectProvider(opts)],
  ['openai-compatible', (opts: object): ModelProvider => new OpenAICompatibleProvider(opts)],
  ['xai', (opts: object): ModelProvider => new XaiProvider(opts)],
])('%s grantsTool', (_name, make) => {
  it('denies workspace tools to a read-only allowlist without a store (the #4060 child)', () => {
    const provider = make({ permissions: READ_ONLY });
    expect(provider.grantsTool?.('workspace_publish')).toBe(false);
    expect(provider.grantsTool?.('workspace_query')).toBe(false);
  });

  it('denies workspace tools to a read-only allowlist even when a store is present', () => {
    const provider = make({ permissions: READ_ONLY, workspaceStore: new WorkspaceStore() });
    expect(provider.grantsTool?.('workspace_publish')).toBe(false);
  });

  it('grants workspace tools when allowlisted and a store is present', () => {
    const provider = make({ permissions: WITH_WORKSPACE, workspaceStore: new WorkspaceStore() });
    expect(provider.grantsTool?.('workspace_publish')).toBe(true);
    expect(provider.grantsTool?.('workspace_query')).toBe(true);
  });
});
