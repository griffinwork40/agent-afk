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

import { describeCredentialSource } from './auth-wizard.describe-source.js';
import { env } from '../config/env.js';
import { loadClaudeCodeOauthToken } from '../agent/auth/keychain.js';

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

  it('returns Claude Code login source when keychain token exists', () => {
    vi.mocked(loadClaudeCodeOauthToken).mockReturnValue('sk-ant-oat01-keychain');
    expect(describeCredentialSource()).toBe('Claude Code login (keychain)');
  });

  it('returns generic fallback when no credential source is found', () => {
    expect(describeCredentialSource()).toBe('existing credential');
  });
});
