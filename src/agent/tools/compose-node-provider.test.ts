import { describe, it, expect } from 'vitest';
import { resolveComposeNodeProvider } from './compose-node-provider.js';

describe('resolveComposeNodeProvider', () => {
  it('always returns a provider even when workspace disabled and node is unrestricted', () => {
    const result = resolveComposeNodeProvider('claude-haiku-5-5', undefined, undefined, {});
    expect(result).toHaveProperty('provider');
  });

  it('returns a provider when workspace store is present', () => {
    // minimal stub — just needs to be truthy
    const store = {} as any;
    const result = resolveComposeNodeProvider('claude-haiku-5-5', store, undefined, {});
    expect(result).toHaveProperty('provider');
  });

  it('returns a provider when restricted (readOnlyBash)', () => {
    const result = resolveComposeNodeProvider('claude-haiku-5-5', undefined, undefined, { readOnlyBash: true });
    expect(result).toHaveProperty('provider');
  });
});
