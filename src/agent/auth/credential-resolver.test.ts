/**
 * Credential injection tests — especially xAI: session config.apiKey must
 * never carry SuperGrok OAuth access tokens (ambiguous-auth footgun).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadXaiApiKey,
  resolveCredentialForModel,
  preloadClaudeKeychainOAuth,
} from './credential-resolver.js';
import { refreshClaudeCodeOauthToken } from './keychain.js';

// Keep the network/keychain refresh hermetic — preloadClaudeKeychainOAuth's
// guard is what's under test, not the real token exchange.
vi.mock('./keychain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./keychain.js')>();
  return { ...actual, refreshClaudeCodeOauthToken: vi.fn(async () => 'sk-ant-oat01-refreshed') };
});

// providerForModel is env-aware; keep hermetic for grok routing + explicit hints.
vi.mock('../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/index.js')>();
  return {
    ...actual,
    providerForModel: (
      model: string | undefined,
      hints?: { explicit?: string },
    ) => {
      const explicit = hints?.explicit?.trim().toLowerCase();
      if (explicit === 'xai') return 'xai' as const;
      if (explicit === 'xai-oauth' || explicit === 'xai_oauth') return 'xai-oauth' as const;
      if (explicit === 'openai' || explicit === 'openai-compatible') {
        return 'openai-compatible' as const;
      }
      if (explicit === 'anthropic' || explicit === 'anthropic-direct') {
        return 'anthropic-direct' as const;
      }
      const m = (model ?? '').toLowerCase();
      if (m.startsWith('grok') || m === 'xai' || m.includes('xai')) {
        if (m.includes('oauth')) return 'xai-oauth' as const;
        return 'xai' as const;
      }
      if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) {
        return 'openai-compatible' as const;
      }
      return 'anthropic-direct' as const;
    },
  };
});

describe('loadXaiApiKey', () => {
  const original = process.env.XAI_API_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = original;
  });

  it('returns XAI_API_KEY when set', () => {
    process.env.XAI_API_KEY = 'xai-metered-key-9999';
    expect(loadXaiApiKey()).toBe('xai-metered-key-9999');
  });

  it('returns undefined when unset', () => {
    delete process.env.XAI_API_KEY;
    expect(loadXaiApiKey()).toBeUndefined();
  });
});

describe('resolveCredentialForModel — xAI injection contract', () => {
  const originalXai = process.env.XAI_API_KEY;
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.XAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalXai;
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
  });

  it('injects XAI_API_KEY for grok models (apikey path)', () => {
    process.env.XAI_API_KEY = 'xai-only-key';
    expect(resolveCredentialForModel('grok-4.5')).toBe('xai-only-key');
  });

  it('returns undefined for grok when only OAuth would be available (no env key)', () => {
    // Even if SuperGrok tokens exist on disk, session config must not receive
    // them — XaiProvider resolves the store itself.
    delete process.env.XAI_API_KEY;
    expect(resolveCredentialForModel('grok-4.5')).toBeUndefined();
  });

  it('never injects OPENAI_API_KEY for grok models', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-leak';
    delete process.env.XAI_API_KEY;
    expect(resolveCredentialForModel('grok-4.5')).toBeUndefined();
  });

  it('still returns OPENAI_API_KEY for gpt models', () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(resolveCredentialForModel('gpt-4o')).toBe('sk-openai');
  });

  it('explicit xai with Claude model returns only XAI_API_KEY (never Anthropic)', () => {
    process.env.XAI_API_KEY = 'xai-forced';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leak';
    expect(resolveCredentialForModel('claude-sonnet-4-6', { explicit: 'xai' })).toBe('xai-forced');
  });

  it('explicit xai with Claude model and no XAI_API_KEY returns undefined (not Anthropic)', () => {
    delete process.env.XAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leak';
    expect(resolveCredentialForModel('claude-sonnet-4-6', { explicit: 'xai' })).toBeUndefined();
  });

  it('without explicit hints, Claude model still resolves Anthropic', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-ok';
    delete process.env.XAI_API_KEY;
    expect(resolveCredentialForModel('claude-sonnet-4-6')).toBe('sk-ant-ok');
  });
});

describe('preloadClaudeKeychainOAuth — startup refresh guard', () => {
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth;
  });

  it('skips the refresh for non-Anthropic providers (no dead keychain work)', async () => {
    expect(await preloadClaudeKeychainOAuth('openai-compatible')).toBeUndefined();
    expect(await preloadClaudeKeychainOAuth('xai')).toBeUndefined();
    expect(await preloadClaudeKeychainOAuth('xai-oauth')).toBeUndefined();
    expect(refreshClaudeCodeOauthToken).not.toHaveBeenCalled();
  });

  it('skips the refresh when an env credential already takes precedence', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-env';
    expect(await preloadClaudeKeychainOAuth('anthropic-direct')).toBeUndefined();

    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-env';
    expect(await preloadClaudeKeychainOAuth('anthropic-direct')).toBeUndefined();

    expect(refreshClaudeCodeOauthToken).not.toHaveBeenCalled();
  });

  it('refreshes the keychain token (and returns it) for Anthropic with no env credential', async () => {
    const token = await preloadClaudeKeychainOAuth('anthropic-direct');
    expect(refreshClaudeCodeOauthToken).toHaveBeenCalledOnce();
    expect(token).toBe('sk-ant-oat01-refreshed');
  });
});
