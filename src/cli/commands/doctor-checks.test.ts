import { describe, it, expect, vi } from 'vitest';
import { checkImportAvailable, checkAnthropicKey, checkCodexKey } from './doctor-checks.js';
import type { DetectedSource } from '../../config/import-sources.js';
import type { OpenAIAuthResolution } from '../../agent/providers/openai-compatible/auth.js';

/** Minimal fixture for a present source with zero assets. */
function makeSource(
  overrides: Partial<DetectedSource> = {},
): DetectedSource {
  return {
    binary: 'claude-code',
    label: 'Claude Code',
    present: true,
    plugins: [],
    skills: [],
    mcpServers: [],
    mcpConfigPath: null,
    mcpFormat: 'json',
    ...overrides,
  };
}

vi.mock('../../agent/auth/credential-resolver.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../agent/auth/credential-resolver.js')>();
  return { ...orig, preloadClaudeKeychainOAuth: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../agent/providers/openai-compatible/auth.js', () => ({
  resolveOpenAIAuth: vi.fn(),
}));

describe('checkAnthropicKey', () => {
  it('calls preloadClaudeKeychainOAuth before checking the key', async () => {
    const { preloadClaudeKeychainOAuth } = await import(
      '../../agent/auth/credential-resolver.js'
    );
    await checkAnthropicKey();
    expect(preloadClaudeKeychainOAuth).toHaveBeenCalledWith('anthropic-direct');
  });
});

describe('checkCodexKey — uses full resolveOpenAIAuth chain', () => {
  async function mockResolve(resolution: OpenAIAuthResolution) {
    const { resolveOpenAIAuth } = await import(
      '../../agent/providers/openai-compatible/auth.js'
    );
    vi.mocked(resolveOpenAIAuth).mockReturnValue(resolution);
  }

  it('passes when OPENAI_API_KEY env var is present', async () => {
    await mockResolve({ apiKey: 'sk-openai-test1234', source: 'env', last4: '1234', envVar: 'OPENAI_API_KEY' });
    const result = await checkCodexKey();
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('OPENAI_API_KEY');
    expect(result.detail).toContain('1234');
  });

  it('passes when CODEX_API_KEY env var is present', async () => {
    await mockResolve({ apiKey: 'sk-codex-test5678', source: 'env', last4: '5678', envVar: 'CODEX_API_KEY' });
    const result = await checkCodexKey();
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('CODEX_API_KEY');
  });

  it('passes when ~/.codex/auth.json has an API key (codex-cli source)', async () => {
    await mockResolve({ apiKey: 'sk-codex-file-9012', source: 'codex-cli', last4: '9012' });
    const result = await checkCodexKey();
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('Codex CLI auth');
    expect(result.detail).toContain('9012');
  });

  it('passes when ChatGPT-subscription OAuth is active (#2757 regression)', async () => {
    await mockResolve({
      apiKey: 'eyJ-chatgpt-oauth-token',
      source: 'chatgpt-oauth',
      last4: 'oken',
      accountId: 'user-acct-abcd',
    });
    const result = await checkCodexKey();
    // Must be pass — not a warn — so no false alarm for OAuth users
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('ChatGPT subscription OAuth');
    // Never logs raw token material
    expect(result.detail).not.toContain('eyJ-chatgpt-oauth-token');
  });

  it('warns when ChatGPT-subscription OAuth token is expired', async () => {
    await mockResolve({
      apiKey: null,
      source: 'chatgpt-oauth-expired',
      expiresAt: Math.floor(Date.now() / 1000) - 3600,
    });
    const result = await checkCodexKey();
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('expired');
    expect(result.fix).toContain('codex');
  });

  it('warns (with opt-in hint) when ChatGPT OAuth is present but AFK_OPENAI_CHATGPT_OAUTH is not set', async () => {
    await mockResolve({ apiKey: null, source: 'no-usable-auth-codex-oauth' });
    const result = await checkCodexKey();
    expect(result.state).toBe('warn');
    expect(result.detail).toContain('ChatGPT');
    expect(result.fix).toContain('AFK_OPENAI_CHATGPT_OAUTH=1');
  });

  it('warns when no OpenAI auth is available at all', async () => {
    await mockResolve({ apiKey: null, source: 'no-usable-auth' });
    const result = await checkCodexKey();
    expect(result.state).toBe('warn');
    expect(result.fix).toContain('OPENAI_API_KEY');
  });
});

describe('checkImportAvailable', () => {
  it('returns null when detected list is empty', async () => {
    const result = await checkImportAvailable({ detected: [] });
    expect(result).toBeNull();
  });

  it('returns null when all sources are not present', async () => {
    const result = await checkImportAvailable({
      detected: [makeSource({ present: false, plugins: [{ name: 'my-plugin', path: '/p' }] })],
    });
    expect(result).toBeNull();
  });

  it('returns null when present source has no plugins or skills', async () => {
    const result = await checkImportAvailable({
      detected: [makeSource({ present: true, plugins: [], skills: [] })],
    });
    expect(result).toBeNull();
  });

  it('returns null when every present source with assets is already trusted', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          present: true,
          plugins: [{ name: 'my-plugin', path: '/p' }],
        }),
      ],
      trusted: { 'claude-code': { plugins: true, skills: true, mcp: true } },
    });
    expect(result).toBeNull();
  });

  it('returns a warn Check when an untrusted present source has plugins', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          label: 'Claude Code',
          present: true,
          plugins: [{ name: 'my-plugin', path: '/p' }],
          skills: [],
        }),
      ],
      trusted: {},
    });
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Claude Code');
    expect(result?.fix).toContain('afk migrate');
  });

  it('returns a warn Check when an untrusted present source has skills', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'codex',
          label: 'Codex',
          present: true,
          plugins: [],
          skills: [{ name: 'my-skill', path: '/s' }],
        }),
      ],
      trusted: {},
    });
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Codex');
    expect(result?.fix).toContain('afk migrate');
  });

  it('reports only untrusted sources when mixed', async () => {
    const result = await checkImportAvailable({
      detected: [
        makeSource({
          binary: 'claude-code',
          label: 'Claude Code',
          present: true,
          plugins: [{ name: 'p', path: '/p' }],
        }),
        makeSource({
          binary: 'codex',
          label: 'Codex',
          present: true,
          skills: [{ name: 's', path: '/s' }],
        }),
      ],
      trusted: { 'claude-code': { plugins: true, skills: true, mcp: true } },
    });
    // Only 'codex' is untrusted
    expect(result).not.toBeNull();
    expect(result?.state).toBe('warn');
    expect(result?.detail).toContain('Codex');
    expect(result?.detail).not.toContain('Claude Code');
  });
});
