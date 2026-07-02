/**
 * Tests for the fork-time child credential fallback.
 *
 * Run with: pnpm test -- src/agent/tools/child-credential.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  applyManagerApiKeyFallback,
  applyParentCredentialFallback,
  isAnthropicCredential,
} from './child-credential.js';

// Anthropic-routed child model; OpenAI-routed child model. If providerForModel's
// routing ever changes for these, the gating assertions below break loudly.
const ANTHROPIC_CHILD = 'sonnet';
const OPENAI_CHILD = 'gpt-5';

const ANTHROPIC_OAUTH = 'sk-ant-oat01-EXAMPLE';
const ANTHROPIC_API = 'sk-ant-api03-EXAMPLE';
const OPENAI_KEY = 'sk-proj-EXAMPLE';

describe('isAnthropicCredential', () => {
  it('accepts sk-ant-oat (OAuth) and sk-ant-api (API key) tokens', () => {
    expect(isAnthropicCredential(ANTHROPIC_OAUTH)).toBe(true);
    expect(isAnthropicCredential(ANTHROPIC_API)).toBe(true);
  });

  it('rejects OpenAI-shaped, empty, and undefined credentials', () => {
    expect(isAnthropicCredential(OPENAI_KEY)).toBe(false);
    expect(isAnthropicCredential('')).toBe(false);
    expect(isAnthropicCredential(undefined)).toBe(false);
  });
});

describe('applyParentCredentialFallback', () => {
  it('returns the freshly-resolved credential unchanged when non-empty', () => {
    // Even when the parent credential differs, a successful per-model
    // resolution always wins — no fallback.
    const out = applyParentCredentialFallback({
      childModel: ANTHROPIC_CHILD,
      resolved: 'sk-ant-oat01-RESOLVED',
      parentApiKey: 'sk-ant-oat01-PARENT',
    });
    expect(out).toBe('sk-ant-oat01-RESOLVED');
  });

  it('falls back to an Anthropic-shaped parent OAuth token when resolution is empty (the expired-keychain case)', () => {
    expect(
      applyParentCredentialFallback({
        childModel: ANTHROPIC_CHILD,
        resolved: undefined,
        parentApiKey: ANTHROPIC_OAUTH,
      }),
    ).toBe(ANTHROPIC_OAUTH);
  });

  it('falls back to an Anthropic-shaped parent API key when resolution is empty', () => {
    expect(
      applyParentCredentialFallback({
        childModel: ANTHROPIC_CHILD,
        resolved: '',
        parentApiKey: ANTHROPIC_API,
      }),
    ).toBe(ANTHROPIC_API);
  });

  it('does NOT forward an OpenAI-shaped parent credential to an Anthropic child (anti-leak)', () => {
    expect(
      applyParentCredentialFallback({
        childModel: ANTHROPIC_CHILD,
        resolved: undefined,
        parentApiKey: OPENAI_KEY,
      }),
    ).toBeUndefined();
  });

  it('does NOT forward an Anthropic parent credential to an OpenAI-routed child (anti-leak, #640 invariant)', () => {
    expect(
      applyParentCredentialFallback({
        childModel: OPENAI_CHILD,
        resolved: undefined,
        parentApiKey: ANTHROPIC_OAUTH,
      }),
    ).toBeUndefined();
  });

  it('leaves an OpenAI child credential-less by returning the empty resolution unchanged', () => {
    // OpenAI children resolve via their own auth chain; the fallback must be a
    // no-op for them regardless of parent shape.
    expect(
      applyParentCredentialFallback({
        childModel: OPENAI_CHILD,
        resolved: undefined,
        parentApiKey: OPENAI_KEY,
      }),
    ).toBeUndefined();
  });

  it('returns undefined when resolution is empty and there is no parent credential', () => {
    expect(
      applyParentCredentialFallback({
        childModel: ANTHROPIC_CHILD,
        resolved: undefined,
        parentApiKey: undefined,
      }),
    ).toBeUndefined();
  });
});

describe('applyManagerApiKeyFallback', () => {
  it('preserves an explicit non-empty config key (caller wins), regardless of provider', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: OPENAI_CHILD,
        configApiKey: OPENAI_KEY,
        parentApiKey: ANTHROPIC_OAUTH,
      }),
    ).toBe(OPENAI_KEY);
    expect(
      applyManagerApiKeyFallback({
        childModel: ANTHROPIC_CHILD,
        configApiKey: ANTHROPIC_API,
        parentApiKey: ANTHROPIC_OAUTH,
      }),
    ).toBe(ANTHROPIC_API);
  });

  it('never leaks an Anthropic-shaped parent credential to an OpenAI-routed child (the forkSubagent leak)', () => {
    // The exact composition-boundary bug: the executor cleared apiKey
    // (configApiKey === undefined) and the manager's fallback used to
    // reintroduce the Anthropic parent key. Must resolve to undefined.
    expect(
      applyManagerApiKeyFallback({
        childModel: OPENAI_CHILD,
        configApiKey: undefined,
        parentApiKey: ANTHROPIC_OAUTH,
      }),
    ).toBeUndefined();
    expect(
      applyManagerApiKeyFallback({
        childModel: OPENAI_CHILD,
        configApiKey: undefined,
        parentApiKey: ANTHROPIC_API,
      }),
    ).toBeUndefined();
  });

  it('treats an empty-string config key as absent (matching the legacy || semantics)', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: OPENAI_CHILD,
        configApiKey: '',
        parentApiKey: ANTHROPIC_OAUTH,
      }),
    ).toBeUndefined();
    expect(
      applyManagerApiKeyFallback({
        childModel: ANTHROPIC_CHILD,
        configApiKey: '',
        parentApiKey: ANTHROPIC_OAUTH,
      }),
    ).toBe(ANTHROPIC_OAUTH);
  });

  it('lets an OpenAI-shaped parent credential flow to an OpenAI-routed child (same-provider inheritance)', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: OPENAI_CHILD,
        configApiKey: undefined,
        parentApiKey: OPENAI_KEY,
      }),
    ).toBe(OPENAI_KEY);
  });

  it('lets the parent credential flow to an Anthropic-routed child (pre-existing inheritance path)', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: ANTHROPIC_CHILD,
        configApiKey: undefined,
        parentApiKey: ANTHROPIC_OAUTH,
      }),
    ).toBe(ANTHROPIC_OAUTH);
  });

  it('returns undefined when neither config nor parent credential exists', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: ANTHROPIC_CHILD,
        configApiKey: undefined,
        parentApiKey: undefined,
      }),
    ).toBeUndefined();
  });
});

// Both-direction gate: when the manager supplies `parentProvider` (derived once
// from the parent model), inheritance is gated on provider identity — never on
// key shape. This closes the reverse leak (OpenAI parent key → Anthropic child)
// that the key-shape-only guard above could not detect.
describe('applyManagerApiKeyFallback — provider-identity gate (parentProvider)', () => {
  // A local-Anthropic-shim key: routes to anthropic-direct but is NOT sk-ant-
  // shaped, so a key-shape guard cannot recognize it — only the provider can.
  const LOCAL_SHIM_KEY = 'local-shim-secret-123';

  it('never leaks an OpenAI parent credential to an Anthropic-routed child (the reverse leak)', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: ANTHROPIC_CHILD,
        configApiKey: undefined,
        parentApiKey: OPENAI_KEY,
        parentProvider: 'openai-compatible',
      }),
    ).toBeUndefined();
  });

  it('never leaks an Anthropic parent credential to an OpenAI-routed child', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: OPENAI_CHILD,
        configApiKey: undefined,
        parentApiKey: ANTHROPIC_OAUTH,
        parentProvider: 'anthropic-direct',
      }),
    ).toBeUndefined();
  });

  it('inherits the parent credential for a same-provider child (both directions)', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: OPENAI_CHILD,
        configApiKey: undefined,
        parentApiKey: OPENAI_KEY,
        parentProvider: 'openai-compatible',
      }),
    ).toBe(OPENAI_KEY);
    expect(
      applyManagerApiKeyFallback({
        childModel: ANTHROPIC_CHILD,
        configApiKey: undefined,
        parentApiKey: ANTHROPIC_OAUTH,
        parentProvider: 'anthropic-direct',
      }),
    ).toBe(ANTHROPIC_OAUTH);
  });

  it('inherits a non-sk-ant local-shim key for an Anthropic child (provider gate, not shape)', () => {
    // Proves the identity gate preserves the local-Anthropic-shim inheritance
    // path without any key-shape sniffing — the key here is unrecognizable by
    // isAnthropicCredential, so only parentProvider makes this correct.
    expect(
      applyManagerApiKeyFallback({
        childModel: ANTHROPIC_CHILD,
        configApiKey: undefined,
        parentApiKey: LOCAL_SHIM_KEY,
        parentProvider: 'anthropic-direct',
      }),
    ).toBe(LOCAL_SHIM_KEY);
  });

  it('lets an explicit child key win even when parentProvider mismatches', () => {
    expect(
      applyManagerApiKeyFallback({
        childModel: ANTHROPIC_CHILD,
        configApiKey: ANTHROPIC_API,
        parentApiKey: OPENAI_KEY,
        parentProvider: 'openai-compatible',
      }),
    ).toBe(ANTHROPIC_API);
  });
});
