/**
 * Unit tests for `routesInjectedProviderForFallback` and `injectedFirstFactory`
 * (B in the test spec).
 *
 * These are pure-function unit tests: no AgentSession, no wire.
 * `getConfiguredFallbackModel` is called by routesInjectedProviderForFallback
 * internally. We control it via the config-file / cache-reset path
 * (src/cli/config/json-tier.ts) since this test file lives under src/agent/
 * and cannot import src/cli/ — but `fallback-model.ts` itself imports
 * `loadJsonConfig` from cli/config/json-tier, so we mock that module directly.
 *
 * Fallback control: vi.mock on './fallback-model.js' is NOT used here because
 * we ARE testing the real functions from that module. Instead we mock the
 * dependency (`../../cli/config/json-tier.js`) that getConfiguredFallbackModel
 * reads, so the real routesInjectedProviderForFallback + getConfiguredFallbackModel
 * code paths execute with controlled config data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Control the config read that getConfiguredFallbackModel performs.
const mockLoadJsonConfig = vi.hoisted(() => vi.fn());
vi.mock('../../cli/config/json-tier.js', () => ({
  loadJsonConfig: mockLoadJsonConfig,
  resetJsonConfigCache: vi.fn(),
}));

import {
  routesInjectedProviderForFallback,
  injectedFirstFactory,
} from './fallback-model.js';
import type { ModelProvider } from '../provider.js';

function withFallback(value: string | undefined): void {
  mockLoadJsonConfig.mockReturnValue({
    config: { fallbackModel: value },
  });
}

function makeProvider(name: string): ModelProvider {
  return { name } as unknown as ModelProvider;
}

beforeEach(() => {
  withFallback('claude-haiku-5-5');
});

// ---------------------------------------------------------------------------
// B: routesInjectedProviderForFallback
// ---------------------------------------------------------------------------
describe('routesInjectedProviderForFallback', () => {
  it('returns true when providerFactory set + not subagent fork + fallback configured', () => {
    expect(
      routesInjectedProviderForFallback({
        providerFactory: () => makeProvider('anthropic'),
      }),
    ).toBe(true);
  });

  it('returns true when isSubagentFork is undefined (default)', () => {
    expect(
      routesInjectedProviderForFallback({
        providerFactory: () => makeProvider('anthropic'),
      }),
    ).toBe(true);
  });

  it('returns false when providerFactory is undefined', () => {
    expect(
      routesInjectedProviderForFallback({
        providerFactory: undefined,
      }),
    ).toBe(false);
  });

  it('returns false when isSubagentFork is true', () => {
    expect(
      routesInjectedProviderForFallback({
        providerFactory: () => makeProvider('anthropic'),
        isSubagentFork: true,
      }),
    ).toBe(false);
  });

  it('returns false when no fallback model is configured', () => {
    withFallback(undefined);
    expect(
      routesInjectedProviderForFallback({
        providerFactory: () => makeProvider('anthropic'),
      }),
    ).toBe(false);
  });

  it('returns false when fallback model is an empty string', () => {
    withFallback('');
    expect(
      routesInjectedProviderForFallback({
        providerFactory: () => makeProvider('anthropic'),
      }),
    ).toBe(false);
  });

  it('returns false when all conditions fail (no factory, fork, no fallback)', () => {
    withFallback(undefined);
    expect(
      routesInjectedProviderForFallback({
        providerFactory: undefined,
        isSubagentFork: true,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B: injectedFirstFactory
// ---------------------------------------------------------------------------
describe('injectedFirstFactory', () => {
  it('returns the injected object when the factory builds a provider with the same name', () => {
    const injected = makeProvider('anthropic');
    const built = makeProvider('anthropic'); // same name, different object
    const factory = (_model: string | undefined): ModelProvider => built;
    const wrapped = injectedFirstFactory(injected, factory);
    // Same name → injected object is returned (identity, not just equal name).
    expect(wrapped('claude-sonnet-4-6')).toBe(injected);
    expect(wrapped('claude-sonnet-4-6')).not.toBe(built);
  });

  it('returns the built provider when names differ (cross-family fallback)', () => {
    const injected = makeProvider('anthropic');
    const openaiBuilt = makeProvider('openai-compatible');
    const factory = (_model: string | undefined): ModelProvider => openaiBuilt;
    const wrapped = injectedFirstFactory(injected, factory);
    expect(wrapped('gpt-4o')).toBe(openaiBuilt);
    expect(wrapped('gpt-4o')).not.toBe(injected);
  });

  it('works when the factory is not memoized (called multiple times)', () => {
    const injected = makeProvider('anthropic');
    let callCount = 0;
    const factory = (_model: string | undefined): ModelProvider => {
      callCount += 1;
      return makeProvider('openai-compatible');
    };
    const wrapped = injectedFirstFactory(injected, factory);
    wrapped('gpt-4o');
    wrapped('gpt-4o');
    // Factory was called both times (not memoized by injectedFirstFactory itself).
    expect(callCount).toBe(2);
  });

  it('passes model through to the factory', () => {
    const injected = makeProvider('anthropic');
    const receivedModels: Array<string | undefined> = [];
    const factory = (model: string | undefined): ModelProvider => {
      receivedModels.push(model);
      return makeProvider('openai-compatible');
    };
    const wrapped = injectedFirstFactory(injected, factory);
    wrapped('gpt-4o');
    wrapped(undefined);
    expect(receivedModels).toEqual(['gpt-4o', undefined]);
  });
});
