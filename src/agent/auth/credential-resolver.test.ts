/**
 * Credential injection tests — especially xAI: session config.apiKey must
 * never carry SuperGrok OAuth access tokens (ambiguous-auth footgun).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadXaiApiKey,
  resolveCredentialForModel,
} from './credential-resolver.js';

// providerForModel is env-aware; keep hermetic for grok routing.
vi.mock('../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/index.js')>();
  return {
    ...actual,
    providerForModel: (model: string | undefined) => {
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

  beforeEach(() => {
    delete process.env.XAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalXai;
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAI;
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
});
