/**
 * Regression test for the `/allow-dir`-grant-dropped bug.
 *
 * Before the fix, the REPL bootstrap called its provider factory twice for the
 * startup family — once to build the `startupProvider` it wired `/allow-dir` to,
 * and once inside the ProviderRouter's `buildInner` to build the instance that
 * actually ran queries. Those were SEPARATE `AnthropicDirectProvider` instances
 * with independent read/write grant arrays, so `/allow-dir` grants landed on the
 * dead startup instance and were silently invisible to the query runner.
 *
 * `createMemoizedProviderFactory` fixes this by memoizing per family: the startup
 * call and the router's same-family call return the SAME instance, so grants flow
 * through. These tests lock that invariant in place.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createMemoizedProviderFactory } from './provider-factory.js';
import { AnthropicDirectProvider, providerForModel } from '../../../agent/providers/index.js';
import type { ModelProvider } from '../../../agent/provider.js';

describe('createMemoizedProviderFactory', () => {
  const built: AnthropicDirectProvider[] = [];

  afterEach(() => {
    // Release the default SQLite MemoryStore each constructed provider opened.
    for (const p of built) p.close();
    built.length = 0;
  });

  it('a /allow-dir grant on the startup instance is visible to the router-built same-family instance', () => {
    const factory = createMemoizedProviderFactory(
      () => {
        const p = new AnthropicDirectProvider();
        built.push(p);
        return p;
      },
      (model) => providerForModel(model),
    );

    // Simulates bootstrap: build startupProvider for the session's startup model
    // and wire /allow-dir to it.
    const startupProvider = factory('claude-sonnet-4-5') as AnthropicDirectProvider;
    startupProvider.addReadRoot('/tmp/allow-dir-grant-test', 'slash');

    // Simulates the ProviderRouter's buildInner resolving the provider for turn 1
    // (same family, possibly a different model alias).
    const routerInner = factory('claude-opus-4') as AnthropicDirectProvider;

    // The fix: same instance, so the grant is visible to the query runner.
    expect(routerInner).toBe(startupProvider);
    expect(routerInner.getGrants().readRoots).toContain('/tmp/allow-dir-grant-test');
    // Only one provider was built for the family (no throwaway startup instance).
    expect(built).toHaveLength(1);
  });

  it('builds a distinct instance per provider family', () => {
    const factory = createMemoizedProviderFactory(
      () => {
        const p = new AnthropicDirectProvider();
        built.push(p);
        return p;
      },
      (model) => providerForModel(model),
    );

    const anthropic = factory('claude-sonnet-4-5');
    const openai = factory('gpt-4o');

    expect(openai).not.toBe(anthropic);
    expect(built).toHaveLength(2);
  });

  it('honors a fixed key (--provider override) — every model shares one instance', () => {
    // When --provider is set, the bootstrap key function returns the fixed
    // provider string for every model, so all models resolve to one instance.
    const factory = createMemoizedProviderFactory(
      () => {
        const p = new AnthropicDirectProvider();
        built.push(p);
        return p;
      },
      () => 'anthropic-direct',
    );

    const a: ModelProvider = factory('claude-sonnet-4-5');
    const b: ModelProvider = factory('gpt-4o'); // different natural family, but key is fixed

    expect(b).toBe(a);
    expect(built).toHaveLength(1);
  });
});
