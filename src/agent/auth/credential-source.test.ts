/**
 * #4882: the session credential source names the provider that serves the
 * model, never the Anthropic tier for a non-Anthropic model. Hermetic: the
 * keychain reader and the ~/.codex reader are mocked; env is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  credentialSourceForModel, tryCredentialSourceForModel, LOCAL_CREDENTIAL_SOURCE, CUSTOM_ENDPOINT_CREDENTIAL_SOURCE,
} from './credential-source.js';
import { DEFAULT_SLOT_BINDINGS, type ModelSlots } from '../session/model-slots.js';
import { loadClaudeCodeOauthToken } from './keychain.js';
import { _resetLastResolvedAnthropicCredential, resolveAnthropicCredential } from './credential-resolver.js';
import { providerForModel } from '../providers/index.js';

const keychain = vi.hoisted(() => ({ token: 'sk-ant-oat01-keychain' as string | undefined, codexAuth: null as string | null }));

vi.mock('./keychain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./keychain.js')>();
  return { ...actual, loadClaudeCodeOauthToken: vi.fn(() => keychain.token) };
});
vi.mock('../providers/openai-compatible/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/openai-compatible/auth.js')>();
  return {
    ...actual,
    resolveOpenAIAuth: (key: string | undefined, _deps: unknown, force?: boolean) => actual.resolveOpenAIAuth(
      key, { homedir: () => '/fake-home', readFile: () => keychain.codexAuth }, force),
  };
});

const ANTHROPIC_TIERS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'claude-code-keychain', 'claude-code-session-refresh'];
const slots = (over: Partial<ModelSlots>): ModelSlots => ({ ...DEFAULT_SLOT_BINDINGS, ...over });
const openaiSlot = (baseUrl: string): ModelSlots =>
  slots({ local: { id: 'qwen3.8-flash-next', provider: 'openai', baseUrl, apiKey: 'k' } });

describe('credentialSourceForModel', () => {
  beforeEach(() => {
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'XAI_API_KEY',
      'AFK_PROVIDER', 'AFK_OPENAI_BASE_URL', 'AFK_LOCAL_BASE_URL', 'AFK_XAI_BASE_URL', 'AFK_XAI_OAUTH_BASE_URL']) vi.stubEnv(k, '');
    keychain.token = 'sk-ant-oat01-keychain';
    keychain.codexAuth = null;
    _resetLastResolvedAnthropicCredential();
    vi.mocked(loadClaudeCodeOauthToken).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('Anthropic model keeps the shipped Anthropic ids', () => {
    expect(credentialSourceForModel('claude-sonnet-4-6')).toBe('claude-code-keychain');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-x');
    expect(credentialSourceForModel('sonnet')).toBe('ANTHROPIC_API_KEY');
  });

  it('self-hosted slot hosts record `local` (fleet anchor: single-label tailnet name)', () => {
    for (const url of ['http://griffin-cm:8767/v1', 'http://127.0.0.1:8000/v1', 'http://100.83.226.50:8767/v1', 'http://box.tail1.ts.net/v1']) {
      const src = credentialSourceForModel('local', { slots: openaiSlot(url) });
      expect(src).toBe(LOCAL_CREDENTIAL_SOURCE);
      expect(ANTHROPIC_TIERS).not.toContain(src);
    }
  });

  it('hosted custom base URLs record custom-endpoint, never local', () => {
    expect(credentialSourceForModel('local', { slots: openaiSlot('https://openrouter.ai/api/v1') })).toBe(CUSTOM_ENDPOINT_CREDENTIAL_SOURCE);
    vi.stubEnv('AFK_OPENAI_BASE_URL', 'https://opencode.ai/zen/v1');
    expect(credentialSourceForModel('gpt-5')).toBe('custom-endpoint');
    vi.stubEnv('AFK_LOCAL_BASE_URL', 'https://anthropic-proxy.example.com');
    expect(credentialSourceForModel('local-qwen')).toBe('custom-endpoint');
    vi.stubEnv('AFK_LOCAL_BASE_URL', '::not a url::');
    expect(credentialSourceForModel('local-qwen')).toBe('custom-endpoint');
  });

  it('an official API host falls through to normal resolution', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-abcdefgh');
    vi.stubEnv('AFK_OPENAI_BASE_URL', 'https://api.openai.com/v1');
    expect(credentialSourceForModel('gpt-5')).toBe('openai:env');
    const s = slots({ large: { id: 'claude-opus-5-5', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' } });
    expect(credentialSourceForModel('large', { slots: s })).toBe('claude-code-keychain');
  });

  it('global loopback AFK_OPENAI_BASE_URL / AFK_LOCAL_BASE_URL record local', () => {
    vi.stubEnv('AFK_OPENAI_BASE_URL', 'http://127.0.0.1:8000/v1');
    expect(credentialSourceForModel('gpt-5')).toBe('local');
    vi.stubEnv('AFK_LOCAL_BASE_URL', 'http://localhost:8080');
    expect(credentialSourceForModel('local-qwen')).toBe('local');
  });

  it('OpenAI ids: env, per-slot config, chatgpt-oauth slot', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-abcdefgh');
    const src = credentialSourceForModel('gpt-5');
    expect(src).toBe('openai:env');
    expect(src).not.toContain('efgh');
    expect(credentialSourceForModel('small', { slots: slots({ small: { id: 'gpt-5-mini', provider: 'openai', apiKey: 'sk-proj-slot' } }) })).toBe('openai:config');
    keychain.codexAuth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'chatgpt-tok' } });
    const s = slots({ medium: { id: 'gpt-5.5', provider: 'chatgpt-oauth' } });
    expect(credentialSourceForModel('medium', { slots: s })).toBe('openai:chatgpt-oauth');
  });

  it('xAI ids: env key; forced --provider xai ignores OAuth and needs a key', () => {
    vi.stubEnv('XAI_API_KEY', 'xai-abcdef');
    expect(credentialSourceForModel('grok-4')).toBe('xai:env');
    expect(credentialSourceForModel('grok-4', { explicit: 'xai' })).toBe('xai:env');
    vi.stubEnv('XAI_API_KEY', '');
    expect(credentialSourceForModel('grok-4', { explicit: 'xai' })).toBeUndefined();
  });

  it('Anthropic slot with a per-slot key records anthropic:config', () => {
    const s = slots({ large: { id: 'claude-opus-5-5', provider: 'anthropic', apiKey: 'sk-ant-api03-slot' } });
    expect(credentialSourceForModel('large', { slots: s })).toBe('anthropic:config');
  });

  it('an explicit Anthropic key that is not the resolved tier token records nothing', () => {
    expect(credentialSourceForModel('claude-sonnet-4-6', undefined, { configApiKey: 'sk-ant-api03-caller' })).toBeUndefined();
    expect(credentialSourceForModel('claude-sonnet-4-6', undefined, { configApiKey: 'sk-ant-oat01-keychain' })).toBe('claude-code-keychain');
    // A refreshed subscription token is still the subscription class.
    expect(credentialSourceForModel('claude-sonnet-4-6', undefined, { configApiKey: 'sk-ant-oat01-refreshed' })).toBe('claude-code-keychain');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-env');
    expect(credentialSourceForModel('claude-sonnet-4-6', undefined, { configApiKey: 'sk-ant-oat01-other' })).toBeUndefined();
  });

  it('an explicit OpenAI key is the config tier unless it is the ambient env token', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-env');
    expect(credentialSourceForModel('gpt-5', undefined, { configApiKey: 'sk-proj-node' })).toBe('openai:config');
    expect(credentialSourceForModel('gpt-5', undefined, { configApiKey: 'sk-proj-env' })).toBe('openai:env');
  });

  it('noStoreRead never calls the credential store: env tier, else the foreground memo, else nothing', () => {
    expect(credentialSourceForModel('claude-sonnet-4-6', undefined, { noStoreRead: true })).toBeUndefined();
    expect(loadClaudeCodeOauthToken).not.toHaveBeenCalled();
    resolveAnthropicCredential(); // foreground resolution at session start
    vi.mocked(loadClaudeCodeOauthToken).mockClear();
    keychain.token = undefined; // keychain token expired since: the memo still names the subscription
    expect(credentialSourceForModel('claude-sonnet-4-6', undefined, { noStoreRead: true })).toBe('claude-code-keychain');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-x');
    expect(credentialSourceForModel('claude-sonnet-4-6', undefined, { noStoreRead: true })).toBe('ANTHROPIC_API_KEY');
    expect(loadClaudeCodeOauthToken).not.toHaveBeenCalled();
  });

  it('auto routes only to the Anthropic provider, so it records the Anthropic tier', () => {
    expect(providerForModel('auto')).toBe('anthropic-direct');
    expect(credentialSourceForModel('auto')).toBe('claude-code-keychain');
    // An explicit provider reroutes auto as a whole; the id follows that provider.
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-x');
    expect(credentialSourceForModel('auto', { explicit: 'openai' })).toBe('openai:env');
  });

  it('no usable credential yields undefined, not a guess', () => {
    expect(tryCredentialSourceForModel('grok-4')).toBeUndefined();
  });
});
