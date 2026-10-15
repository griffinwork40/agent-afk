import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('./config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./config.js')>();
  return {
    ...original,
    loadCredential: vi.fn(),
  };
});

vi.mock('./auth-wizard.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./auth-wizard.js')>();
  return {
    ...original,
    runAuthWizard: vi.fn(),
  };
});

// providerForModel needs to be mockable — stub the providers module
vi.mock('../agent/providers/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent/providers/index.js')>();
  return {
    ...original,
    providerForModel: vi.fn(() => 'anthropic-direct'),
  };
});

// The startup keychain-OAuth refresh is exercised by its own guard tests in
// credential-resolver.test.ts; here we only assert the detector WIRING (it is
// awaited before the sync loadCredential() read), so stub it out.
vi.mock('../agent/auth/credential-resolver.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent/auth/credential-resolver.js')>();
  return {
    ...original,
    preloadClaudeKeychainOAuth: vi.fn(async () => undefined),
  };
});

// dotenv config — prevent it from actually reading files during tests
vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

// ─── Imports (after mocks are registered) ────────────────────────────────────

import { loadCredential } from './config.js';
import { runAuthWizard } from './auth-wizard.js';
import { providerForModel } from '../agent/providers/index.js';
import { preloadClaudeKeychainOAuth } from '../agent/auth/credential-resolver.js';
import { Command } from 'commander';
import { runFirstRunDetector, needsCredentialGate } from './first-run.js';

// Parsed-command helper; alias/default-command behavior is exercised in the
// companion real-Commander suite rather than duplicated in an argv parser.
const commandFor = (name = 'interactive') => new Command(name);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('needsCredentialGate', () => {
  it('does not gate utility commands', () => {
    expect(needsCredentialGate(commandFor('login'))).toBe(false);
    expect(needsCredentialGate(commandFor('doctor'))).toBe(false);
    expect(needsCredentialGate(commandFor('telegram'))).toBe(false);
  });

  it('does not gate pre-auth commands (login, doctor, config, status, …)', () => {
    for (const cmd of ['login', 'doctor', 'config', 'status', 'plugin', 'completion', 'update']) {
      expect(needsCredentialGate(commandFor(cmd))).toBe(false);
    }
  });

  it('gates commands that need a credential', () => {
    for (const cmd of ['chat', 'interactive', 'daemon', 'farm']) {
      expect(needsCredentialGate(commandFor(cmd))).toBe(true);
    }
  });

  it('gates bare invocation and program-flag-only invocation (REPL start)', () => {
    expect(needsCredentialGate(commandFor())).toBe(true);
    expect(needsCredentialGate(commandFor('interactive'))).toBe(true);
  });
});

describe('runFirstRunDetector', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    // Restore original isTTY value
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it('skips the wizard when a credential is already present', async () => {
    vi.mocked(loadCredential).mockReturnValue('sk-ant-api03-existing-key');
    vi.mocked(providerForModel).mockReturnValue('anthropic-direct');

    await runFirstRunDetector(commandFor());

    expect(runAuthWizard).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('skips the wizard when provider is not anthropic-direct', async () => {
    vi.mocked(loadCredential).mockReturnValue(undefined);
    vi.mocked(providerForModel).mockReturnValue('openai-compatible');

    await runFirstRunDetector(commandFor());

    expect(runAuthWizard).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(preloadClaudeKeychainOAuth).not.toHaveBeenCalled();
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('writes to stderr and exits 1 when no credential and non-TTY', async () => {
    vi.mocked(loadCredential).mockReturnValue(undefined);
    vi.mocked(providerForModel).mockReturnValue('anthropic-direct');

    // Force non-TTY environment
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });

    await runFirstRunDetector(commandFor());

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('No Anthropic credential found'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(runAuthWizard).not.toHaveBeenCalled();
  });

  it('calls runAuthWizard and does not exit when no credential and TTY', async () => {
    vi.mocked(loadCredential).mockReturnValue(undefined);
    vi.mocked(providerForModel).mockReturnValue('anthropic-direct');
    vi.mocked(runAuthWizard).mockResolvedValue(undefined);

    // Force TTY environment
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });

    await runFirstRunDetector(commandFor());

    expect(runAuthWizard).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('refreshes the keychain OAuth token BEFORE the sync credential read', async () => {
    const order: string[] = [];
    vi.mocked(providerForModel).mockReturnValue('anthropic-direct');
    vi.mocked(preloadClaudeKeychainOAuth).mockImplementation(async () => {
      order.push('preload');
      return undefined;
    });
    vi.mocked(loadCredential).mockImplementation(() => {
      order.push('loadCredential');
      return 'sk-ant-api03-existing';
    });

    await runFirstRunDetector(commandFor('daemon'));

    expect(preloadClaudeKeychainOAuth).toHaveBeenCalledWith('anthropic-direct');
    expect(order).toEqual(['preload', 'loadCredential']);
  });

  it('recovers the non-TTY daemon path when the preload refreshes an expired token', async () => {
    // Regression for the P1 gap: an expired keychain token makes the pre-parse
    // loadCredential() return undefined, so before this fix the non-TTY daemon
    // exited(1) here — before the command action's own refresh could run. The
    // preload now writes a fresh token back so the post-preload read succeeds.
    vi.mocked(providerForModel).mockReturnValue('anthropic-direct');
    let refreshed = false;
    vi.mocked(preloadClaudeKeychainOAuth).mockImplementation(async () => {
      refreshed = true;
      return 'sk-ant-oat01-fresh';
    });
    vi.mocked(loadCredential).mockImplementation(() =>
      refreshed ? 'sk-ant-oat01-fresh' : undefined,
    );
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });

    await runFirstRunDetector(commandFor('daemon'));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(runAuthWizard).not.toHaveBeenCalled();
  });

  it('uses the refreshed token when credential-store write-back fails', async () => {
    vi.mocked(providerForModel).mockReturnValue('anthropic-direct');
    vi.mocked(preloadClaudeKeychainOAuth).mockResolvedValue('sk-ant-oat01-fresh');
    vi.mocked(loadCredential).mockReturnValue(undefined);
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });

    await runFirstRunDetector(commandFor('chat'));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(runAuthWizard).not.toHaveBeenCalled();
  });

  it('does not attempt a refresh for non-gated commands', async () => {
    await runFirstRunDetector(commandFor('doctor'));
    expect(preloadClaudeKeychainOAuth).not.toHaveBeenCalled();
  });
});
