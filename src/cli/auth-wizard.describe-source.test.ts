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

import { describeCredentialSource } from './auth-wizard.describe-source.js';
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

  it('returns session-refresh label when process-local refreshed token is active (tier 3)', () => {
    // env vars unset, keychain returns nothing, but a token was refreshed
    // in-process and write-back to the credential store failed — matches
    // refreshedClaudeCodeOauthToken in loadAnthropicCredential (tier 3).
    vi.mocked(hasProcessLocalRefreshedToken).mockReturnValue(true);
    expect(describeCredentialSource()).toBe('Claude Code login (session refresh)');
  });

  it('returns keychain label when only keychain token exists (tier 4)', () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-keychain');
    expect(describeCredentialSource()).toBe('Claude Code login (keychain)');
  });

  it('prefers session-refresh over keychain when both tiers are present', () => {
    // Both tier 3 (process-local refresh) and tier 4 (keychain) are active.
    // describeCredentialSource must match loadAnthropicCredential's order,
    // where refreshedClaudeCodeOauthToken is checked before loadClaudeCodeOauthToken().
    vi.mocked(hasProcessLocalRefreshedToken).mockReturnValue(true);
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-keychain');
    expect(describeCredentialSource()).toBe('Claude Code login (session refresh)');
  });

  it('returns generic fallback when no credential source is found', () => {
    expect(describeCredentialSource()).toBe('existing credential');
  });
});
