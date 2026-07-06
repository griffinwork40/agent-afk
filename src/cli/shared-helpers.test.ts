/**
 * Tests for system-prompt layering helpers and GrantManager type guard.
 *
 * Invariant under test (system-prompt): the framework base
 * (`prompts/system-prompt.md`) is the UNCONDITIONAL foundation; the operator
 * overlay (AFK_SYSTEM_PROMPT → afk.config.json → AFK.md) is APPENDED on top,
 * never substituted for the base. This is the inverse of the historical
 * `overlay ?? framework` behavior, where any operator prompt replaced the
 * framework base wholesale.
 *
 * Invariant under test (isGrantManager): any provider that structurally exposes
 * addReadRoot / addWriteRoot / revokeRoot / getGrants passes — regardless of its
 * concrete class — and a plain object missing any of those methods does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPERATOR_CONFIG_HEADER,
  composeSystemPrompt,
  isGrantManager,
  resolveBaseSystemPrompt,
} from './shared-helpers.js';
import { loadConfig } from './config.js';
import { AnthropicDirectProvider } from '../agent/providers/index.js';
import { OpenAICompatibleProvider } from '../agent/providers/openai-compatible/index.js';

describe('getApiKey / getModel provider agreement (regression: default-model divergence)', () => {
  // Regression guard for a bug where getApiKey() re-read `AFK_MODEL ?? CLAUDE_MODEL`
  // directly (possibly undefined) instead of resolving against getModel() (which
  // defaults to the literal 'sonnet'). With both model env vars unset and
  // AFK_OPENAI_BASE_URL set, `providerForModel(undefined)` fell through to the
  // Tier-4 env hint -> 'openai-compatible' (OPENAI_API_KEY), while getModel()
  // returned 'sonnet' -> 'anthropic-direct'. The session then paired an
  // anthropic-routed model with an OpenAI credential (401s downstream).
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env['AFK_MODEL'];
    delete process.env['CLAUDE_MODEL'];
    delete process.env['AFK_PROVIDER'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['CODEX_API_KEY'];
    process.env['AFK_OPENAI_BASE_URL'] = 'http://localhost:8000/v1';
    process.env['OPENAI_API_KEY'] = 'sk-proj-SENTINEL-OPENAI-KEY';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-SENTINEL-ANTHROPIC-KEY';
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it('getApiKey() resolves the credential for the same provider getModel() routes to, with AFK_MODEL/CLAUDE_MODEL unset and AFK_OPENAI_BASE_URL set', async () => {
    const { getApiKey, getModel } = await import('./shared-helpers.js');
    const { providerForModel } = await import('../agent/providers/index.js');

    const resolvedModel = getModel();
    const resolvedApiKey = getApiKey();

    // getModel() defaults to the literal 'sonnet' -> anthropic-direct.
    expect(resolvedModel).toBe('sonnet');
    expect(providerForModel(resolvedModel)).toBe('anthropic-direct');

    // getApiKey() must agree: it should resolve the Anthropic credential,
    // not fall through the AFK_OPENAI_BASE_URL Tier-4 hint via an undefined model.
    expect(resolvedApiKey).toBe('sk-ant-api03-SENTINEL-ANTHROPIC-KEY');
  });
});

// Mock the config module so loadConfig() (the overlay source) is controllable.
// loadSystemPrompt() is an in-module call in shared-helpers and reads the real
// prompts/system-prompt.md from the package tree — i.e. the framework base is
// genuinely present in these tests, which is the production invariant.
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return { ...actual, loadConfig: vi.fn() };
});

const FRAMEWORK = '# Agent AFK\n\nYou operate inside a runtime.';
const OVERLAY = '# Project\n\nUse pnpm. Never touch main.';

describe('composeSystemPrompt', () => {
  it('appends the overlay beneath the operator-config header when both present', () => {
    const out = composeSystemPrompt(FRAMEWORK, OVERLAY);
    expect(out).toBeDefined();
    const fwIdx = out!.indexOf(FRAMEWORK);
    const headerIdx = out!.indexOf(OPERATOR_CONFIG_HEADER);
    const ovIdx = out!.indexOf(OVERLAY);
    expect(fwIdx).toBe(0);
    expect(fwIdx).toBeLessThan(headerIdx);
    expect(headerIdx).toBeLessThan(ovIdx);
  });

  it('does NOT let the overlay replace the framework base (regression guard)', () => {
    const out = composeSystemPrompt(FRAMEWORK, OVERLAY);
    expect(out).toContain(FRAMEWORK);
    expect(out).toContain(OVERLAY);
    expect(out).not.toBe(OVERLAY);
  });

  it('returns the framework unchanged when no overlay is present', () => {
    expect(composeSystemPrompt(FRAMEWORK, undefined)).toBe(FRAMEWORK);
    expect(composeSystemPrompt(FRAMEWORK, '')).toBe(FRAMEWORK);
    expect(composeSystemPrompt(FRAMEWORK, '   \n  ')).toBe(FRAMEWORK);
  });

  it('returns the overlay alone when the framework is genuinely absent (dev/test edge)', () => {
    expect(composeSystemPrompt(undefined, OVERLAY)).toBe(OVERLAY);
    expect(composeSystemPrompt('', OVERLAY)).toBe(OVERLAY);
  });

  it('returns undefined when neither is present', () => {
    expect(composeSystemPrompt(undefined, undefined)).toBeUndefined();
    expect(composeSystemPrompt('', '')).toBeUndefined();
    expect(composeSystemPrompt('  ', undefined)).toBeUndefined();
  });

  it('never emits a dangling header (header only appears with both parts)', () => {
    expect(composeSystemPrompt(FRAMEWORK, undefined)).not.toContain(OPERATOR_CONFIG_HEADER);
    expect(composeSystemPrompt(undefined, OVERLAY)).not.toContain(OPERATOR_CONFIG_HEADER);
  });
});

describe('resolveBaseSystemPrompt', () => {
  function fakeConfig(overlay: string | undefined, source: string | undefined) {
    return {
      model: 'sonnet',
      maxTokens: 8192,
      temperature: 1,
      updatePolicy: 'prompt',
      ...(overlay !== undefined ? { systemPrompt: overlay } : {}),
      ...(source !== undefined ? { systemPromptSource: source } : {}),
    } as unknown as ReturnType<typeof loadConfig>;
  }

  beforeEach(() => {
    vi.mocked(loadConfig).mockReset();
  });

  it('layers framework + overlay and reports a composed source', () => {
    vi.mocked(loadConfig).mockReturnValue(fakeConfig('Operator says hi', 'afk-md:/repo/AFK.md'));
    const { prompt, source } = resolveBaseSystemPrompt();
    expect(prompt).toBeDefined();
    expect(prompt).toContain('Operator says hi');
    expect(prompt).toContain(OPERATOR_CONFIG_HEADER);
    // Framework base is present too — the operating posture is not replaced.
    expect(prompt!.length).toBeGreaterThan('Operator says hi'.length + OPERATOR_CONFIG_HEADER.length);
    expect(source).toBe('framework+afk-md:/repo/AFK.md');
  });

  it('reports source "framework" when no overlay is configured', () => {
    vi.mocked(loadConfig).mockReturnValue(fakeConfig(undefined, undefined));
    const { prompt, source } = resolveBaseSystemPrompt();
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(OPERATOR_CONFIG_HEADER);
    expect(source).toBe('framework');
  });

  it('prefixes whatever overlay tier won (env example)', () => {
    vi.mocked(loadConfig).mockReturnValue(fakeConfig('env override', 'env:AFK_SYSTEM_PROMPT'));
    const { source } = resolveBaseSystemPrompt();
    expect(source).toBe('framework+env:AFK_SYSTEM_PROMPT');
  });
});

describe('isGrantManager', () => {
  // Providers opened in these tests need to be closed so SQLite handles release.
  const anthropicProviders: AnthropicDirectProvider[] = [];
  const openaiProviders: OpenAICompatibleProvider[] = [];

  afterEach(() => {
    for (const p of anthropicProviders) p.close();
    anthropicProviders.length = 0;
    for (const p of openaiProviders) p.close();
    openaiProviders.length = 0;
  });

  it('returns true for AnthropicDirectProvider (which implements GrantManager)', () => {
    const p = new AnthropicDirectProvider();
    anthropicProviders.push(p);
    expect(isGrantManager(p)).toBe(true);
  });

  it('returns true for OpenAICompatibleProvider (which implements GrantManager)', () => {
    const p = new OpenAICompatibleProvider();
    openaiProviders.push(p);
    expect(isGrantManager(p)).toBe(true);
  });

  it('returns false for a plain empty object', () => {
    expect(isGrantManager({})).toBe(false);
  });

  it('returns false for an object missing some GrantManager methods', () => {
    // Has three of the four required methods — must still fail.
    expect(isGrantManager({
      addReadRoot: () => {},
      addWriteRoot: () => {},
      revokeRoot: () => {},
      // getGrants intentionally absent
    })).toBe(false);
  });

  it('returns false for null and non-objects', () => {
    expect(isGrantManager(null)).toBe(false);
    expect(isGrantManager(undefined)).toBe(false);
    expect(isGrantManager(42)).toBe(false);
    expect(isGrantManager('string')).toBe(false);
  });

  it('returns true for a plain mock object exposing all four methods', () => {
    const mock = {
      addReadRoot: (_path: string) => {},
      addWriteRoot: (_path: string) => {},
      revokeRoot: (_path: string) => {},
      getGrants: () => ({ resolveBase: undefined, readRoots: [], writeRoots: [] }),
    };
    expect(isGrantManager(mock)).toBe(true);
  });
});
