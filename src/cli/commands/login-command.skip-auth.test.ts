/**
 * Integration tests for the skip-auth branch of `registerLoginCommand`.
 *
 * Covers:
 *   1. Early-exit when `loadAnthropicCredential` returns a credential
 *      (no --force, no token).
 *   2. No credential found -- falls through to `runAuthWizard` (first-time user).
 *   3. `--force` flag bypasses the credential check and calls `runAuthWizard`.
 *   4. Token argument bypasses the credential check and calls `runAuthWizard`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

// --- mocks declared before any import that might transitively load them ---

vi.mock('../../agent/providers/index.js', () => ({
  providerForModel: vi.fn(() => 'anthropic-direct'),
}));

vi.mock('../../agent/auth/credential-resolver.js', () => ({
  loadAnthropicCredential: vi.fn(() => undefined as string | undefined),
  preloadClaudeKeychainOAuth: vi.fn(async () => undefined as string | undefined),
}));

vi.mock('../auth-wizard.describe-source.js', () => ({
  describeCredentialSource: vi.fn(() => 'Claude Code login (keychain)'),
}));

vi.mock('../auth-wizard.js', () => ({
  runAuthWizard: vi.fn(async () => undefined),
  promptToken: vi.fn(async () => 'sk-ant-api03-test'),
}));

vi.mock('../shared-helpers.js', () => ({
  getModel: vi.fn(() => 'claude-sonnet-4-5'),
}));

vi.mock('../palette.js', () => ({
  palette: {
    success: (s: string) => s,
    warning: (s: string) => s,
    meta: (s: string) => s,
    brand: (s: string) => s,
    error: (s: string) => s,
  },
}));

import { registerLoginCommand } from './login-command.js';
import { loadAnthropicCredential, preloadClaudeKeychainOAuth } from '../../agent/auth/credential-resolver.js';
import { runAuthWizard } from '../auth-wizard.js';

// Helper: build a fresh Commander program with the login command registered.
function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests
  registerLoginCommand(program);
  return program;
}

describe('registerLoginCommand skip-auth branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits early when an existing credential is found (no --force, no token)', async () => {
    vi.mocked(loadAnthropicCredential).mockReturnValue('sk-ant-oat01-existing');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = makeProgram();
    await program.parseAsync(['node', 'afk', 'login']);

    // preload should have been called
    expect(preloadClaudeKeychainOAuth).toHaveBeenCalledWith('anthropic-direct');
    // runAuthWizard must NOT have been called
    expect(runAuthWizard).not.toHaveBeenCalled();
    // Should have printed the "already authenticated" message
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Already authenticated'),
    );

    consoleSpy.mockRestore();
  });

  it('calls runAuthWizard when no credential is found (first-time user)', async () => {
    // Default mock returns undefined -- no existing credential.
    vi.mocked(loadAnthropicCredential).mockReturnValue(undefined);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = makeProgram();
    await program.parseAsync(['node', 'afk', 'login']);

    // The keychain-refresh guard runs before the credential check.
    expect(preloadClaudeKeychainOAuth).toHaveBeenCalledWith('anthropic-direct');
    // No credential found -- must fall through to runAuthWizard.
    expect(runAuthWizard).toHaveBeenCalledWith(undefined);
    // Must NOT have printed the "already authenticated" early-exit message.
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Already authenticated'),
    );

    consoleSpy.mockRestore();
  });

  it('bypasses credential check and calls runAuthWizard when --force is set', async () => {
    // Even with a credential present, --force should skip the early exit.
    vi.mocked(loadAnthropicCredential).mockReturnValue('sk-ant-oat01-existing');

    const program = makeProgram();
    await program.parseAsync(['node', 'afk', 'login', '--force']);

    // runAuthWizard should have been called (no token supplied, so undefined)
    expect(runAuthWizard).toHaveBeenCalledWith(undefined);
    // preload should NOT have been called (guard short-circuits before it)
    expect(preloadClaudeKeychainOAuth).not.toHaveBeenCalled();
  });

  it('bypasses credential check and calls runAuthWizard when a token argument is provided', async () => {
    // Even with a credential present, an explicit token bypasses the guard.
    vi.mocked(loadAnthropicCredential).mockReturnValue('sk-ant-oat01-existing');

    const program = makeProgram();
    await program.parseAsync(['node', 'afk', 'login', 'sk-ant-api03-new']);

    // runAuthWizard should have been called with the supplied token
    expect(runAuthWizard).toHaveBeenCalledWith('sk-ant-api03-new');
    // preload should NOT have been called (guard short-circuits before it)
    expect(preloadClaudeKeychainOAuth).not.toHaveBeenCalled();
  });
});
