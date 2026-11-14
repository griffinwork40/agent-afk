/**
 * #4882: the session credential source names the provider that serves the
 * model, never the Anthropic tier for a non-Anthropic model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { credentialSourceForModel, tryCredentialSourceForModel, LOCAL_CREDENTIAL_SOURCE } from './credential-source.js';
import { DEFAULT_SLOT_BINDINGS, type ModelSlots } from '../session/model-slots.js';

vi.mock('./keychain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./keychain.js')>();
  return { ...actual, loadClaudeCodeOauthToken: vi.fn(() => 'sk-ant-oat01-keychain') };
});

const ANTHROPIC_TIERS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'claude-code-keychain', 'claude-code-session-refresh'];

function slots(over: Partial<ModelSlots>): ModelSlots {
  return { ...DEFAULT_SLOT_BINDINGS, ...over };
}

describe('credentialSourceForModel', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('CODEX_API_KEY', '');
    vi.stubEnv('XAI_API_KEY', '');
    vi.stubEnv('AFK_PROVIDER', '');
    vi.stubEnv('AFK_OPENAI_BASE_URL', '');
    vi.stubEnv('AFK_LOCAL_BASE_URL', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('Anthropic model keeps the shipped Anthropic ids', () => {
    expect(credentialSourceForModel('claude-sonnet-4-6')).toBe('claude-code-keychain');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-x');
    expect(credentialSourceForModel('sonnet')).toBe('ANTHROPIC_API_KEY');
  });

  it('local slot (custom baseUrl) records `local`, never an Anthropic tier', () => {
    const s = slots({ local: { id: 'qwen3.8-flash-next', provider: 'openai', baseUrl: 'http://box:8767/v1', apiKey: 'k' } });
    const src = credentialSourceForModel('local', { slots: s });
    expect(src).toBe(LOCAL_CREDENTIAL_SOURCE);
    expect(credentialSourceForModel('qwen3.8-flash-next', { slots: s })).toBe('local');
    expect(ANTHROPIC_TIERS).not.toContain(src);
  });

  it('OpenAI model with OPENAI_API_KEY records openai:env', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-abcdefgh');
    const src = credentialSourceForModel('gpt-5');
    expect(src).toBe('openai:env');
    expect(src).not.toContain('efgh');
  });

  it('OpenAI slot with a per-slot key records openai:config', () => {
    const s = slots({ small: { id: 'gpt-5-mini', provider: 'openai', apiKey: 'sk-proj-slot' } });
    expect(credentialSourceForModel('small', { slots: s })).toBe('openai:config');
  });

  it('global AFK_OPENAI_BASE_URL shim records local', () => {
    vi.stubEnv('AFK_OPENAI_BASE_URL', 'http://127.0.0.1:8000/v1');
    expect(credentialSourceForModel('gpt-5')).toBe('local');
  });

  it('AFK_LOCAL_BASE_URL Anthropic shim records local', () => {
    vi.stubEnv('AFK_LOCAL_BASE_URL', 'http://127.0.0.1:8080');
    expect(credentialSourceForModel('local-qwen')).toBe('local');
  });

  it('xAI with XAI_API_KEY records xai:env', () => {
    vi.stubEnv('XAI_API_KEY', 'xai-abcdef');
    expect(credentialSourceForModel('grok-4')).toBe('xai:env');
  });

  it('Anthropic slot with a per-slot key records anthropic:config', () => {
    const s = slots({ large: { id: 'claude-opus-5-5', provider: 'anthropic', apiKey: 'sk-ant-api03-slot' } });
    expect(credentialSourceForModel('large', { slots: s })).toBe('anthropic:config');
  });

  it('no usable credential yields undefined, not a guess', () => {
    vi.stubEnv('XAI_API_KEY', '');
    expect(tryCredentialSourceForModel('grok-4')).toBeUndefined();
  });
});
