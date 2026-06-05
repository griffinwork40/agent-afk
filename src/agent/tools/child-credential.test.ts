/**
 * Tests for the fork-time child credential fallback.
 *
 * Run with: pnpm test -- src/agent/tools/child-credential.test.ts
 */

import { describe, expect, it } from 'vitest';
import { applyParentCredentialFallback, isAnthropicCredential } from './child-credential.js';

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
