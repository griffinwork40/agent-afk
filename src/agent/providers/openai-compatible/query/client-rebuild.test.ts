/**
 * Regression test for client-rebuild.ts: buildRefreshedClient must pass
 * opts.baseURL to resolveWireMode so a custom endpoint is not silently
 * redirected to chatgpt.com after a token refresh (PR #3388 finding #1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRefreshedClient } from './client-rebuild.js';
import type { OpenAIAuthResolution } from '../auth.js';

// Spy on resolveWireMode to capture the third argument.
const resolveWireModeSpy = vi.fn().mockReturnValue({ mode: 'chat-completions' });
vi.mock('../responses-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../responses-config.js')>();
  return {
    ...orig,
    resolveWireMode: (...args: unknown[]) => resolveWireModeSpy(...args),
  };
});

// Stub client factory so we don't need a real OpenAI SDK.
vi.mock('./client.js', () => ({
  resolveClientFactory: () => (opts: Record<string, unknown>) => opts,
  buildOpenAIAdmissionFetch: () => null,
}));

describe('buildRefreshedClient', () => {
  beforeEach(() => {
    resolveWireModeSpy.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes opts.baseURL as customBaseURL to resolveWireMode (regression: endpoint hijack on refresh)', () => {
    const auth: OpenAIAuthResolution = {
      apiKey: 'tok',
      source: 'chatgpt-oauth',
      last4: '_tok',
      accountId: 'acct-1',
    };
    buildRefreshedClient(auth, {
      model: 'gpt-4o-mini',
      baseURL: 'http://localhost:8000/v1',
    } as Parameters<typeof buildRefreshedClient>[1]);

    expect(resolveWireModeSpy).toHaveBeenCalledTimes(1);
    // Third argument must be the custom baseURL, not undefined.
    expect(resolveWireModeSpy.mock.calls[0]![2]).toBe('http://localhost:8000/v1');
  });

  it('passes undefined when opts.baseURL is not set', () => {
    const auth: OpenAIAuthResolution = {
      apiKey: 'tok',
      source: 'chatgpt-oauth',
      last4: '_tok',
      accountId: 'acct-1',
    };
    buildRefreshedClient(auth, {
      model: 'gpt-4o-mini',
    } as Parameters<typeof buildRefreshedClient>[1]);

    expect(resolveWireModeSpy).toHaveBeenCalledTimes(1);
    expect(resolveWireModeSpy.mock.calls[0]![2]).toBeUndefined();
  });
});
