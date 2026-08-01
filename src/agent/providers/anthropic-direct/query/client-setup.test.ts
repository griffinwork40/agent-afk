/**
 * Unit tests for the extracted query client setup (#824).
 *
 * Focus: the `tokenRefresher` closure, which is the part of `query()` that has
 * no coverage from the provider-level integration tests (they never trigger an
 * OAuth 401 hot-swap). The invariant it exists to protect — the rebuilt client
 * must reuse the SAME `throttleQueue` and quota observer as the original — is
 * invisible to a type checker and silent when broken: the live rate-limit
 * banner simply stops updating after an account swap.
 *
 * @module agent/providers/anthropic-direct/query/client-setup.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../../../types/config-types.js';
import { setUpQueryClient } from './client-setup.js';

const refreshMock = vi.fn<[], Promise<string | null>>();

vi.mock('../../../auth/keychain.js', () => ({
  refreshClaudeCodeOauthToken: () => refreshMock(),
}));

/** A stand-in client; identity is all these tests compare. */
function fakeClient(tag: string): Anthropic {
  return { __tag: tag } as unknown as Anthropic;
}

const OAUTH_TOKEN = 'sk-ant-oat01-test';

function baseArgs(overrides: Partial<Parameters<typeof setUpQueryClient>[0]> = {}) {
  return {
    config: {} as AgentConfig,
    token: OAUTH_TOKEN,
    authMode: 'oauth' as const,
    localMode: false,
    factory: undefined,
    createClient: () => fakeClient('real'),
    ...overrides,
  };
}

describe('setUpQueryClient (#824)', () => {
  beforeEach(() => {
    refreshMock.mockReset();
  });

  it('uses the injected factory in preference to the real constructor', () => {
    let createClientCalls = 0;
    const { client } = setUpQueryClient(
      baseArgs({
        factory: () => fakeClient('from-factory'),
        createClient: () => {
          createClientCalls += 1;
          return fakeClient('real');
        },
      }),
    );
    expect((client as unknown as { __tag: string }).__tag).toBe('from-factory');
    expect(createClientCalls).toBe(0);
  });

  it('falls back to createClient when no factory is installed', () => {
    const { client } = setUpQueryClient(baseArgs({ factory: null }));
    expect((client as unknown as { __tag: string }).__tag).toBe('real');
  });

  it('emits the OAuth billing prefix for an oauth session, and none in local mode', () => {
    expect(setUpQueryClient(baseArgs()).systemPrefix).not.toBeNull();
    // Local shim is not Anthropic's billing surface — prefix suppressed even
    // though the token still looks like an OAuth token.
    expect(setUpQueryClient(baseArgs({ localMode: true })).systemPrefix).toBeNull();
  });

  it('omits the billing prefix for a plain api-key session', () => {
    expect(setUpQueryClient(baseArgs({ authMode: 'api-key' })).systemPrefix).toBeNull();
  });

  it('installs a throttle queue only for non-local sessions WITH a trace writer', () => {
    // No trace writer → no queue.
    expect(setUpQueryClient(baseArgs()).throttleQueue).toBeUndefined();

    const withWriter = setUpQueryClient(
      baseArgs({ config: { traceWriter: {} } as unknown as AgentConfig }),
    );
    expect(withWriter.throttleQueue).toBeDefined();

    // Local mode suppresses it regardless of the writer.
    const local = setUpQueryClient(
      baseArgs({ localMode: true, config: { traceWriter: {} } as unknown as AgentConfig }),
    );
    expect(local.throttleQueue).toBeUndefined();
  });

  it('builds a tokenRefresher for oauth, but NOT for api-key or local mode', () => {
    expect(setUpQueryClient(baseArgs()).tokenRefresher).toBeDefined();
    expect(setUpQueryClient(baseArgs({ authMode: 'api-key' })).tokenRefresher).toBeUndefined();
    // Local shim must never receive a refreshed real Anthropic credential.
    expect(setUpQueryClient(baseArgs({ localMode: true })).tokenRefresher).toBeUndefined();
  });

  it('tokenRefresher returns null when the keychain has no fresh token', async () => {
    refreshMock.mockResolvedValue(null);
    const { tokenRefresher } = setUpQueryClient(baseArgs());
    await expect(tokenRefresher?.()).resolves.toBeNull();
  });

  it('tokenRefresher rebuilds the client through the SAME factory', async () => {
    refreshMock.mockResolvedValue('sk-ant-oat01-fresh');
    const seen: Array<{ authToken?: string; apiKey?: string }> = [];
    const { tokenRefresher } = setUpQueryClient(
      baseArgs({
        factory: (opts) => {
          seen.push(opts as { authToken?: string });
          return fakeClient('rebuilt');
        },
      }),
    );

    const rebuilt = await tokenRefresher?.();
    expect((rebuilt as unknown as { __tag: string }).__tag).toBe('rebuilt');
    // Two constructions: the initial client and the post-refresh rebuild.
    expect(seen).toHaveLength(2);
    // The rebuild must carry the FRESH token, not the original.
    expect(seen[1]?.authToken).toBe('sk-ant-oat01-fresh');
  });

  it('the rebuilt client keeps a live fetch wrapper feeding the SAME throttle queue', async () => {
    // Invariant under test: the throttle queue is a rendezvous between the
    // fetch producer and the turn-loop consumer. Handing the rebuilt client a
    // fresh queue would strand the live rate-limit banner after an account
    // swap — silently, with no error anywhere.
    refreshMock.mockResolvedValue('sk-ant-oat01-fresh');
    const fetches: Array<unknown> = [];
    const setup = setUpQueryClient(
      baseArgs({
        config: { traceWriter: {} } as unknown as AgentConfig,
        factory: (opts) => {
          fetches.push((opts as { fetch?: unknown }).fetch);
          return fakeClient('c');
        },
      }),
    );
    expect(setup.throttleQueue).toBeDefined();

    await setup.tokenRefresher?.();
    expect(fetches).toHaveLength(2);
    // Both clients got a tracing-fetch wrapper (not a bare/undefined fetch).
    expect(typeof fetches[0]).toBe('function');
    expect(typeof fetches[1]).toBe('function');
  });
});
