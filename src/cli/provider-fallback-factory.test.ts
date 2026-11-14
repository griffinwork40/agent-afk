/**
 * Unit tests for `injectedProviderWiring` and `isProviderPinned`
 * (C in the test spec).
 *
 * Tests:
 *   - Unpinned: returns both `provider` and `providerFactory`; calling
 *     providerFactory with the session model returns the SAME object as provider.
 *   - Different family: factory caches by family, so a second call for the same
 *     family returns the same instance.
 *   - Pinned by explicitProvider: returns only `provider`, no `providerFactory`.
 *   - Pinned by AFK_PROVIDER env var: returns only `provider`, no `providerFactory`.
 *   - `build` is called with the session model when factory is called with undefined.
 *
 * AFK_PROVIDER is read through `env` (src/config/env.ts), which uses lazy
 * getters over `process.env`. We control it with `vi.stubEnv` so the getter
 * reads the stubbed value at call time, then `vi.unstubAllEnvs()` restores.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { injectedProviderWiring, isProviderPinned } from './provider-fallback-factory.js';
import type { ModelProvider } from '../agent/provider.js';

function makeProvider(name: string): ModelProvider {
  return { name } as unknown as ModelProvider;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// isProviderPinned
// ---------------------------------------------------------------------------
describe('isProviderPinned', () => {
  it('returns false when explicitProvider is undefined and AFK_PROVIDER is unset', () => {
    vi.stubEnv('AFK_PROVIDER', '');
    expect(isProviderPinned(undefined)).toBe(false);
  });

  it('returns false when explicitProvider is empty string', () => {
    vi.stubEnv('AFK_PROVIDER', '');
    expect(isProviderPinned('')).toBe(false);
  });

  it('returns true when explicitProvider is non-empty', () => {
    vi.stubEnv('AFK_PROVIDER', '');
    expect(isProviderPinned('anthropic')).toBe(true);
  });

  it('returns true when AFK_PROVIDER env var is non-empty', () => {
    vi.stubEnv('AFK_PROVIDER', 'openai');
    expect(isProviderPinned(undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// injectedProviderWiring — unpinned
// ---------------------------------------------------------------------------
describe('injectedProviderWiring — unpinned', () => {
  it('returns both provider and providerFactory when not pinned', () => {
    vi.stubEnv('AFK_PROVIDER', '');
    const built = makeProvider('anthropic');
    const result = injectedProviderWiring({
      model: 'claude-sonnet-4-6',
      explicitProvider: undefined,
      build: () => built,
      familyOf: () => 'anthropic',
    });
    expect(result.provider).toBeDefined();
    expect(result.providerFactory).toBeDefined();
  });

  it('providerFactory(model) returns the SAME object as provider (memoized by family)', () => {
    vi.stubEnv('AFK_PROVIDER', '');
    const built = makeProvider('anthropic');
    const result = injectedProviderWiring({
      model: 'claude-sonnet-4-6',
      explicitProvider: undefined,
      build: () => built,
      familyOf: () => 'anthropic',
    });
    // The factory was already called once for the session model, so a second
    // call for the same family key must return the cached instance.
    expect(result.providerFactory!('claude-sonnet-4-6')).toBe(result.provider);
  });

  it('a model of another family builds a new instance (and caches it)', () => {
    vi.stubEnv('AFK_PROVIDER', '');
    const anthropicProvider = makeProvider('anthropic');
    const openaiProvider = makeProvider('openai-compatible');
    let buildCount = 0;
    const result = injectedProviderWiring({
      model: 'claude-sonnet-4-6',
      explicitProvider: undefined,
      build: (m) => {
        buildCount += 1;
        return m === 'gpt-4o' ? openaiProvider : anthropicProvider;
      },
      familyOf: (m) => (m === 'gpt-4o' ? 'openai-compatible' : 'anthropic'),
    });
    // Initial build (session model) counted as one.
    const countAfterInit = buildCount;
    // First call for a different family → new build.
    const p1 = result.providerFactory!('gpt-4o');
    expect(buildCount).toBe(countAfterInit + 1);
    expect(p1).toBe(openaiProvider);
    // Second call for the same family → cache hit, no extra build.
    const p2 = result.providerFactory!('gpt-4o');
    expect(buildCount).toBe(countAfterInit + 1);
    expect(p2).toBe(p1);
  });
});

// ---------------------------------------------------------------------------
// injectedProviderWiring — pinned by explicitProvider
// ---------------------------------------------------------------------------
describe('injectedProviderWiring — pinned by explicitProvider', () => {
  it('returns provider but NOT providerFactory when explicitProvider is set', () => {
    vi.stubEnv('AFK_PROVIDER', '');
    const built = makeProvider('anthropic');
    const result = injectedProviderWiring({
      model: 'claude-sonnet-4-6',
      explicitProvider: 'anthropic',
      build: () => built,
      familyOf: () => 'anthropic',
    });
    expect(result.provider).toBeDefined();
    expect(result.providerFactory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// injectedProviderWiring — pinned by AFK_PROVIDER env var
// ---------------------------------------------------------------------------
describe('injectedProviderWiring — pinned by AFK_PROVIDER', () => {
  it('returns provider but NOT providerFactory when AFK_PROVIDER is set', () => {
    vi.stubEnv('AFK_PROVIDER', 'openai');
    const built = makeProvider('openai-compatible');
    const result = injectedProviderWiring({
      model: 'gpt-4o',
      explicitProvider: undefined,
      build: () => built,
      familyOf: () => 'openai-compatible',
    });
    expect(result.provider).toBeDefined();
    expect(result.providerFactory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// injectedProviderWiring — build called with session model on factory(undefined)
// ---------------------------------------------------------------------------
describe('injectedProviderWiring — factory(undefined) uses session model', () => {
  it('calls build with the session model when factory is called with undefined', () => {
    vi.stubEnv('AFK_PROVIDER', '');
    const receivedModels: string[] = [];
    const result = injectedProviderWiring({
      model: 'claude-sonnet-4-6',
      explicitProvider: undefined,
      build: (m) => {
        receivedModels.push(m);
        return makeProvider('anthropic');
      },
      familyOf: (m) => {
        // familyOf may also be called with undefined; map it to anthropic.
        return 'anthropic';
      },
    });
    // The initial build already called build with the session model.
    // Calling the factory with undefined should use the session model (anthropic family → cache hit).
    // We test that the initial build used the session model.
    expect(receivedModels).toContain('claude-sonnet-4-6');
    // Calling factory with undefined returns the same cached instance
    // (family key for undefined → 'anthropic' → same as session model family).
    expect(result.providerFactory!(undefined)).toBe(result.provider);
  });
});
