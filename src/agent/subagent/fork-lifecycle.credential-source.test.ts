/**
 * #4882: subagent_lifecycle.started carries the provider-aware credential id
 * of the child's model, and the fork path never reads the credential store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emitForkStarted } from './fork-lifecycle.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import type { AgentConfig } from '../types.js';
import { loadClaudeCodeOauthToken } from '../auth/keychain.js';
import { _resetLastResolvedAnthropicCredential, resolveAnthropicCredential } from '../auth/credential-resolver.js';

vi.mock('../auth/keychain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/keychain.js')>();
  return { ...actual, loadClaudeCodeOauthToken: vi.fn(() => 'sk-ant-oat01-keychain') };
});
vi.mock('../providers/openai-compatible/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/openai-compatible/auth.js')>();
  return {
    ...actual,
    resolveOpenAIAuth: (key: string | undefined, _deps: unknown, force?: boolean) =>
      actual.resolveOpenAIAuth(key, { homedir: () => '/fake-home', readFile: () => null }, force),
  };
});

async function startedPayload(model: string, extra: Partial<AgentConfig> = {}): Promise<Record<string, unknown>> {
  const w = new InMemoryTraceWriter();
  emitForkStarted({
    effectiveTraceWriter: w, id: 'child-1', parentSessionId: 'p', rootId: 'r',
    effectiveChildModel: model, childConfig: { model, ...extra } as AgentConfig,
    promptHead: undefined, effectiveAgentType: undefined, effectiveResolvedAgentType: undefined,
  });
  await new Promise((r) => setTimeout(r, 0));
  const ev = w.events.find((e) => e.kind === 'subagent_lifecycle');
  return ev!.payload as unknown as Record<string, unknown>;
}

describe('emitForkStarted credentialSource', () => {
  beforeEach(() => {
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'XAI_API_KEY',
      'AFK_PROVIDER', 'AFK_OPENAI_BASE_URL', 'AFK_LOCAL_BASE_URL', 'AFK_XAI_BASE_URL', 'AFK_XAI_OAUTH_BASE_URL']) vi.stubEnv(k, '');
    _resetLastResolvedAnthropicCredential();
    vi.mocked(loadClaudeCodeOauthToken).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('never calls the credential store reader; no env tier and no memo → field absent', async () => {
    const p = await startedPayload('claude-sonnet-4-6');
    expect('credentialSource' in p).toBe(false);
    expect(loadClaudeCodeOauthToken).not.toHaveBeenCalled();
  });

  it('Anthropic child records the tier the foreground resolution produced, without a store read', async () => {
    resolveAnthropicCredential();
    vi.mocked(loadClaudeCodeOauthToken).mockClear();
    expect((await startedPayload('claude-sonnet-4-6'))['credentialSource']).toBe('claude-code-keychain');
    expect(loadClaudeCodeOauthToken).not.toHaveBeenCalled();
  });

  it('Anthropic child with a caller key of unknown origin records nothing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-env');
    expect((await startedPayload('claude-sonnet-4-6', { apiKey: 'sk-ant-api03-caller' }))['credentialSource']).toBeUndefined();
    expect((await startedPayload('claude-sonnet-4-6', { apiKey: 'sk-ant-api03-env' }))['credentialSource']).toBe('ANTHROPIC_API_KEY');
  });

  it('Anthropic child on a hosted custom baseUrl records custom-endpoint', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-env');
    expect((await startedPayload('claude-sonnet-4-6', { baseUrl: 'https://gateway.example.com' }))['credentialSource']).toBe('custom-endpoint');
  });

  it('OpenAI child records an openai: id, never the Anthropic tier', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-zzzz');
    const p = await startedPayload('gpt-5');
    expect(p['credentialSource']).toBe('openai:env');
    expect(JSON.stringify(p)).not.toContain('zzzz');
  });

  it('no usable credential omits the field', async () => {
    const p = await startedPayload('grok-4');
    expect('credentialSource' in p).toBe(false);
  });
});
