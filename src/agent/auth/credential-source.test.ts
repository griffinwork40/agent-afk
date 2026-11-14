/**
 * Tests for the provider-aware credential source resolver (#4882).
 *
 * Every underlying resolver is mocked with fakes so no real env var, keychain,
 * `~/.codex/auth.json` or xAI token store is ever read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./credential-resolver.js', () => ({
  resolveAnthropicCredential: vi.fn(),
}));
vi.mock('../providers/openai-compatible/auth.js', () => ({
  resolveOpenAIAuth: vi.fn(),
}));
vi.mock('../providers/xai/auth.js', () => ({
  resolveXaiAuth: vi.fn(),
}));

import { resolveCredentialSourceForModel } from './credential-source.js';
import { resolveAnthropicCredential } from './credential-resolver.js';
import { resolveOpenAIAuth } from '../providers/openai-compatible/auth.js';
import { resolveXaiAuth } from '../providers/xai/auth.js';
import { DEFAULT_SLOT_BINDINGS, type ModelSlots } from '../session/model-slots.js';

const ANTHROPIC_TIERS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'claude-code-keychain',
  'claude-code-session-refresh',
];

function makeSlots(over: Partial<ModelSlots>): ModelSlots {
  return {
    local: over.local ?? { id: DEFAULT_SLOT_BINDINGS.local.id },
    small: over.small ?? { id: DEFAULT_SLOT_BINDINGS.small.id },
    medium: over.medium ?? { id: DEFAULT_SLOT_BINDINGS.medium.id },
    large: over.large ?? { id: DEFAULT_SLOT_BINDINGS.large.id },
    subagent: over.subagent ?? { id: '' },
  };
}

beforeEach(() => {
  vi.mocked(resolveAnthropicCredential).mockReset().mockReturnValue({
    token: 'fake-anthropic-token',
    source: 'claude-code-keychain',
  });
  vi.mocked(resolveOpenAIAuth).mockReset().mockReturnValue({
    apiKey: 'fake-openai-token',
    source: 'chatgpt-oauth',
  });
  vi.mocked(resolveXaiAuth).mockReset().mockReturnValue({
    apiKey: 'fake-xai-token',
    source: 'env',
    mode: 'apikey',
  });
});

describe('resolveCredentialSourceForModel', () => {
  it('returns the Anthropic tier for an Anthropic-routed model', () => {
    expect(resolveCredentialSourceForModel('claude-sonnet-4-6')).toBe('claude-code-keychain');
    expect(resolveOpenAIAuth).not.toHaveBeenCalled();
  });

  it('returns the OpenAI auth source for an OpenAI-routed model', () => {
    expect(resolveCredentialSourceForModel('gpt-5')).toBe('chatgpt-oauth');
    expect(resolveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('forces ChatGPT OAuth resolution for a chatgpt-oauth slot', () => {
    const slots = makeSlots({ small: { id: 'gpt-5-mini', provider: 'chatgpt-oauth' } });
    resolveCredentialSourceForModel('small', { slots });
    expect(resolveOpenAIAuth).toHaveBeenCalledWith(undefined, {}, true);
  });

  it('returns xai-<source> for a Grok model', () => {
    expect(resolveCredentialSourceForModel('grok-4')).toBe('xai-env');
    vi.mocked(resolveXaiAuth).mockReturnValue({ apiKey: 'fake', source: 'xai-oauth', mode: 'oauth' });
    expect(resolveCredentialSourceForModel('grok-4')).toBe('xai-oauth');
  });

  it('records `local` for a keyless self-hosted slot (qwen on a local shim)', () => {
    const slots = makeSlots({ local: { id: 'qwen3.8-flash-next', baseUrl: 'http://localhost:8080/v1' } });
    expect(resolveCredentialSourceForModel('local', { slots })).toBe('local');
    expect(resolveCredentialSourceForModel('qwen3.8-flash-next', { slots })).toBe('local');
    expect(resolveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('records `slot-config` when the slot carries its own key', () => {
    const slots = makeSlots({ small: { id: 'llama-3-70b', baseUrl: 'https://api.together.xyz/v1', apiKey: 'fake-slot-key' } });
    expect(resolveCredentialSourceForModel('small', { slots })).toBe('slot-config');
  });

  it('records `local` for an Anthropic-routed model under AFK_LOCAL_BASE_URL', () => {
    vi.stubEnv('AFK_LOCAL_BASE_URL', 'http://localhost:9000');
    expect(resolveCredentialSourceForModel('local-qwen')).toBe('local');
    expect(resolveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('a non-Anthropic session model NEVER yields an Anthropic tier (the #4882 defect)', () => {
    // Even when the Anthropic resolver would answer (keychain present), and
    // even when the non-Anthropic provider has no usable credential.
    vi.mocked(resolveOpenAIAuth).mockReturnValue({ apiKey: null, source: 'no-usable-auth' });
    vi.mocked(resolveXaiAuth).mockReturnValue({ apiKey: null, source: 'no-usable-auth' });
    const slots = makeSlots({ local: { id: 'qwen3.8-flash-next', baseUrl: 'http://localhost:8080/v1' } });
    for (const model of ['qwen3.8-flash-next', 'local', 'gpt-5', 'o3', 'grok-4', 'mlx-community/Qwen3-32B-4bit']) {
      const id = resolveCredentialSourceForModel(model, { slots });
      expect(ANTHROPIC_TIERS).not.toContain(id);
    }
    expect(resolveAnthropicCredential).not.toHaveBeenCalled();
  });

  it('returns undefined (absent, never guessed) when no credential resolves', () => {
    vi.mocked(resolveAnthropicCredential).mockReturnValue(undefined);
    vi.mocked(resolveOpenAIAuth).mockReturnValue({ apiKey: null, source: 'no-usable-auth' });
    expect(resolveCredentialSourceForModel('claude-sonnet-4-6')).toBeUndefined();
    expect(resolveCredentialSourceForModel('gpt-5')).toBeUndefined();
  });

  it('returns ids only, never token material', () => {
    for (const model of ['claude-sonnet-4-6', 'gpt-5', 'grok-4']) {
      const id = resolveCredentialSourceForModel(model) ?? '';
      expect(id).not.toContain('fake');
    }
  });
});
