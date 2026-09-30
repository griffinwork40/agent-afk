/**
 * Regression tests for `afk status --format json` provider credential mapping.
 *
 * History: before this fix `getApiKey()` (model-routed) was used to populate
 * `providers.anthropic.ok`. An xAI user with only XAI_API_KEY set would get
 * `anthropic.ok: true` because the model-router returned the xAI key for
 * xai/xai-oauth models. Fix: use `loadAnthropicCredential()` (Anthropic-only)
 * for the anthropic block so each provider reflects only its own credentials.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// --- mocks declared before the module under test is imported ---

vi.mock('../../agent/session.js', () => ({
  AgentSession: vi.fn(() => ({
    close: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock('../../agent/providers/index.js', () => ({
  providerForModel: vi.fn(() => 'xai'),
}));

vi.mock('../shared-helpers.js', () => ({
  getModel: vi.fn(() => 'grok-3'),
  getApiKeyForModel: vi.fn(() => 'xai-test-key'),
  getCodexApiKey: vi.fn(() => undefined as string | undefined),
}));

vi.mock('../config.js', () => ({
  resolveCliPermissionMode: vi.fn(() => 'default'),
}));

vi.mock('../render.js', () => ({
  statusPanel: vi.fn(() => 'status-panel'),
}));

vi.mock('../../agent/auth/credential-resolver.js', () => ({
  loadXaiApiKey: vi.fn(() => undefined as string | undefined),
  loadAnthropicCredential: vi.fn(() => undefined as string | undefined),
}));

vi.mock('../auth-wizard.describe-source.js', () => ({
  describeCredentialSource: vi.fn(() => 'ANTHROPIC_API_KEY'),
  credentialSourceId: vi.fn(() => null as string | null),
}));

vi.mock('../../config/env.js', () => ({
  env: {
    OPENAI_API_KEY: undefined as string | undefined,
  },
}));

import { registerStatusCommand } from './status.js';
import { loadXaiApiKey, loadAnthropicCredential } from '../../agent/auth/credential-resolver.js';
import { credentialSourceId } from '../auth-wizard.describe-source.js';
import { providerForModel } from '../../agent/providers/index.js';
import { getModel, getApiKeyForModel, getCodexApiKey } from '../shared-helpers.js';

// Capture JSON written to stdout via console.log.
function captureJsonOutput(fn: () => unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const spy = vi.spyOn(console, 'log').mockImplementationOnce((msg: string) => {
      spy.mockRestore();
      try {
        resolve(JSON.parse(msg) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    Promise.resolve(fn()).catch(reject);
  });
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program);
  return program;
}

describe('afk status --format json provider credential mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('xAI model + only XAI_API_KEY: anthropic.ok=false, xai.ok=true (regression)', async () => {
    // Arrange: active model is xAI, only XAI_API_KEY is present.
    vi.mocked(providerForModel).mockReturnValue('xai');
    vi.mocked(getModel).mockReturnValue('grok-3');
    vi.mocked(getApiKeyForModel).mockReturnValue('xai-test-key');
    vi.mocked(loadAnthropicCredential).mockReturnValue(undefined);
    vi.mocked(loadXaiApiKey).mockReturnValue('xai-test-key');
    vi.mocked(getCodexApiKey).mockReturnValue(undefined);
    vi.mocked(credentialSourceId).mockReturnValue(null);

    const program = makeProgram();
    const outputP = captureJsonOutput(() =>
      program.parseAsync(['node', 'afk', 'status', '--format', 'json']),
    );
    const output = await outputP;

    const providers = output['providers'] as Record<string, { ok: boolean; source: string | null }>;

    // Invariant: anthropic block reflects only Anthropic credentials.
    expect(providers['anthropic']?.ok).toBe(false);
    expect(providers['anthropic']?.source).toBeNull();

    // xAI block should be ok since XAI_API_KEY is set.
    expect(providers['xai']?.ok).toBe(true);
    expect(providers['xai']?.source).toBe('XAI_API_KEY');
  });

  it('Anthropic-only user: anthropic.ok=true, xai.ok=false', async () => {
    vi.mocked(providerForModel).mockReturnValue('anthropic-direct');
    vi.mocked(getModel).mockReturnValue('claude-sonnet-4-5');
    vi.mocked(getApiKeyForModel).mockReturnValue('sk-ant-test');
    vi.mocked(loadAnthropicCredential).mockReturnValue('sk-ant-test');
    vi.mocked(loadXaiApiKey).mockReturnValue(undefined);
    vi.mocked(getCodexApiKey).mockReturnValue(undefined);
    vi.mocked(credentialSourceId).mockReturnValue('ANTHROPIC_API_KEY');

    const program = makeProgram();
    const outputP = captureJsonOutput(() =>
      program.parseAsync(['node', 'afk', 'status', '--format', 'json']),
    );
    const output = await outputP;

    const providers = output['providers'] as Record<string, { ok: boolean; source: string | null }>;

    expect(providers['anthropic']?.ok).toBe(true);
    expect(providers['anthropic']?.source).toBe('ANTHROPIC_API_KEY');
    expect(providers['xai']?.ok).toBe(false);
    expect(providers['xai']?.source).toBeNull();
  });

  it('xAI model + both XAI_API_KEY and ANTHROPIC_API_KEY: both providers ok', async () => {
    vi.mocked(providerForModel).mockReturnValue('xai');
    vi.mocked(getModel).mockReturnValue('grok-3');
    vi.mocked(getApiKeyForModel).mockReturnValue('xai-test-key');
    // Both credentials present.
    vi.mocked(loadAnthropicCredential).mockReturnValue('sk-ant-test');
    vi.mocked(loadXaiApiKey).mockReturnValue('xai-test-key');
    vi.mocked(getCodexApiKey).mockReturnValue(undefined);
    vi.mocked(credentialSourceId).mockReturnValue('ANTHROPIC_API_KEY');

    const program = makeProgram();
    const outputP = captureJsonOutput(() =>
      program.parseAsync(['node', 'afk', 'status', '--format', 'json']),
    );
    const output = await outputP;

    const providers = output['providers'] as Record<string, { ok: boolean; source: string | null }>;

    expect(providers['anthropic']?.ok).toBe(true);
    expect(providers['anthropic']?.source).toBe('ANTHROPIC_API_KEY');
    expect(providers['xai']?.ok).toBe(true);
    expect(providers['xai']?.source).toBe('XAI_API_KEY');
  });
});
