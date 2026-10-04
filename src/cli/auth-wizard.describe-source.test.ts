import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the env module before any imports that read it.
vi.mock('../config/env.js', () => ({
  env: {
    ANTHROPIC_API_KEY: undefined as string | undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined as string | undefined,
  },
}));

vi.mock('../agent/auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: vi.fn(() => undefined as string | undefined),
}));

vi.mock('../agent/auth/credential-resolver.js', () => ({
  hasProcessLocalRefreshedToken: vi.fn(() => false),
}));

import { describeCredentialSource, credentialSourceId } from './auth-wizard.describe-source.js';
import { env } from '../config/env.js';
import { loadClaudeCodeOauthToken } from '../agent/auth/keychain.js';
import { hasProcessLocalRefreshedToken } from '../agent/auth/credential-resolver.js';

describe('describeCredentialSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (env as { ANTHROPIC_API_KEY: string | undefined }).ANTHROPIC_API_KEY = undefined;
    (env as { CLAUDE_CODE_OAUTH_TOKEN: string | undefined }).CLAUDE_CODE_OAUTH_TOKEN = undefined;
  });

  afterEach(() => {
    // Vitest 4: restoreAllMocks() only restores vi.spyOn spies; it no longer
    // resets vi.fn() mocks as v2 did. resetAllMocks() keeps the v2 isolation.
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('returns ANTHROPIC_API_KEY when that env var is set', () => {
    (env as { ANTHROPIC_API_KEY: string | undefined }).ANTHROPIC_API_KEY = 'sk-ant-api03-test';
    expect(describeCredentialSource()).toBe('ANTHROPIC_API_KEY');
  });

  it('returns CLAUDE_CODE_OAUTH_TOKEN when that env var is set (and no API key)', () => {
    (env as { CLAUDE_CODE_OAUTH_TOKEN: string | undefined }).CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test';
    expect(describeCredentialSource()).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('prefers ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN', () => {
    (env as { ANTHROPIC_API_KEY: string | undefined }).ANTHROPIC_API_KEY = 'sk-ant-api03-test';
    (env as { CLAUDE_CODE_OAUTH_TOKEN: string | undefined }).CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test';
    expect(describeCredentialSource()).toBe('ANTHROPIC_API_KEY');
  });

  it('returns keychain label when a keychain token exists (tier 3)', () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-keychain');
    expect(describeCredentialSource()).toBe('Claude Code login (keychain)');
  });

  it('returns session-refresh label when only the process-local refreshed token exists (tier 4)', () => {
    // env vars unset, store yields nothing, but a token was refreshed
    // in-process and write-back to the credential store failed.
    vi.mocked(hasProcessLocalRefreshedToken).mockReturnValue(true);
    expect(describeCredentialSource()).toBe('Claude Code login (session refresh)');
  });

  it('prefers keychain over session-refresh when both tiers are present (matches loader, #2469)', () => {
    // loadAnthropicCredential checks loadClaudeCodeOauthToken() BEFORE
    // refreshedClaudeCodeOauthToken; the cache is filled on every startup
    // preload, so it must not win the label when the store has a token.
    vi.mocked(hasProcessLocalRefreshedToken).mockReturnValue(true);
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-keychain');
    expect(describeCredentialSource()).toBe('Claude Code login (keychain)');
    expect(credentialSourceId()).toBe('claude-code-keychain');
  });

  it('credentialSourceId returns stable ids per tier', () => {
    expect(credentialSourceId()).toBeNull();
    vi.mocked(hasProcessLocalRefreshedToken).mockReturnValue(true);
    expect(credentialSourceId()).toBe('claude-code-session-refresh');
    (env as { CLAUDE_CODE_OAUTH_TOKEN: string | undefined }).CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test';
    expect(credentialSourceId()).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    (env as { ANTHROPIC_API_KEY: string | undefined }).ANTHROPIC_API_KEY = 'sk-ant-api03-test';
    expect(credentialSourceId()).toBe('ANTHROPIC_API_KEY');
  });

  it('returns generic fallback when no credential source is found', () => {
    expect(describeCredentialSource()).toBe('existing credential');
  });
});
