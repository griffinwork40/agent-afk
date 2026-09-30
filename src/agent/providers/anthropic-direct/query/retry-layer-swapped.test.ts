/**
 * Tests for the `swapped` detection fix in {@link RetryLayer.forceClientRefresh}.
 *
 * Bug (#2470): `forceClientRefresh` compared `loadClaudeCodeOauthToken()` BEFORE
 * vs AFTER the refresh. When `claude login` ran externally before `/reauth`,
 * the store already held account B, so both reads returned B and `swapped`
 * was always false — even though the running client moved from A to B.
 *
 * Fix: `RetryLayer` now tracks the token the current client was built with
 * (`_clientToken`, set in the constructor and updated on every swap) and
 * compares against that instead of the live store value.
 *
 * Coverage:
 *  - Client built with token A, store already holds B before refresh → swapped: true
 *  - Client built with token A, store still holds A after refresh    → swapped: false
 *  - `oldAccountId` reflects the token the old client was built with
 *  - `_clientToken` is updated on every successful swap
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before dynamic imports below).
// ---------------------------------------------------------------------------

const loadClaudeCodeOauthTokenMock = vi.hoisted(() => vi.fn<[], string | undefined>());
const parseAccountIdentifierMock = vi.hoisted(() => vi.fn<[string], string>());

vi.mock('../../../auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: loadClaudeCodeOauthTokenMock,
  parseAccountIdentifier: parseAccountIdentifierMock,
}));

// Minimal stub for buildRequestHeaders — the tests don't exercise headers.
vi.mock('../auth.js', () => ({
  buildRequestHeaders: () => ({}),
}));

// Minimal stub for isExtendedCacheTtlActive.
vi.mock('../cache-policy.js', () => ({
  isExtendedCacheTtlActive: () => false,
}));

// ---------------------------------------------------------------------------
// Dynamic imports after mocks are wired.
// ---------------------------------------------------------------------------

const { RetryLayer } = await import('./retry-layer.js');

// ---------------------------------------------------------------------------
// Minimal client stub.
// ---------------------------------------------------------------------------

function makeClient(authToken: string): Anthropic {
  return { _authToken: authToken } as unknown as Anthropic;
}

// ---------------------------------------------------------------------------
// Helper to build a minimal RetryLayer.
// ---------------------------------------------------------------------------

function makeLayer(opts: {
  clientToken: string | undefined;
  refresherToken: string | undefined;
}): InstanceType<typeof RetryLayer> {
  // When the constructor runs, `loadClaudeCodeOauthToken` returns the token
  // the initial client was built with.
  loadClaudeCodeOauthTokenMock.mockReturnValueOnce(opts.clientToken);

  const layer = new RetryLayer({
    client: makeClient(opts.clientToken ?? 'old'),
    authMode: 'oauth',
    initSessionId: 'test-session',
    autoResumeOnUsageLimit: false,
    tokenRefresher: async () => makeClient(opts.refresherToken ?? 'new'),
  });

  return layer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RetryLayer.forceClientRefresh — swapped detection fix (#2470)', () => {
  beforeEach(() => {
    loadClaudeCodeOauthTokenMock.mockReset();
    parseAccountIdentifierMock.mockImplementation((tok) => `acct:${tok}`);
  });

  it('client built with A, store already holds B before refresh → swapped: true', async () => {
    // Arrange: construct with token A, then the store has moved to B BEFORE the
    // refresh call (simulating `claude login` in another terminal).
    const layer = makeLayer({ clientToken: 'token-A', refresherToken: 'new-client' });

    // Store now returns B for the loadClaudeCodeOauthToken call inside forceClientRefresh.
    loadClaudeCodeOauthTokenMock.mockReturnValue('token-B');

    // Act
    const result = await layer.forceClientRefresh();

    // Assert: the comparison is against the token the CLIENT was built with (A),
    // not what the store returned before the refresh (which would also be B).
    expect(result).not.toBeNull();
    expect(result!.swapped).toBe(true);
  });

  it('client built with A, store still holds A after refresh → swapped: false', async () => {
    // Arrange: construct with token A.
    const layer = makeLayer({ clientToken: 'token-A', refresherToken: 'new-client' });

    // Store still returns A — same account, no external login.
    loadClaudeCodeOauthTokenMock.mockReturnValue('token-A');

    // Act
    const result = await layer.forceClientRefresh();

    // Assert: A → A is unchanged.
    expect(result).not.toBeNull();
    expect(result!.swapped).toBe(false);
  });

  it('oldAccountId reflects the token the old client was built with, not the store', async () => {
    // Arrange: client built with A, store already has B.
    const layer = makeLayer({ clientToken: 'token-A', refresherToken: 'new-client' });
    loadClaudeCodeOauthTokenMock.mockReturnValue('token-B');

    // Act
    const result = await layer.forceClientRefresh();

    // Assert: oldAccountId is derived from the client's original token (A),
    // not from whatever the store held before the call.
    expect(result!.oldAccountId).toBe('acct:token-A');
    expect(result!.accountId).toBe('acct:token-B');
  });

  it('_clientToken is updated to the new store value after a successful swap', async () => {
    // After a successful forceClientRefresh, _clientToken must track the new
    // token so a subsequent call compares from the new baseline.
    const layer = makeLayer({ clientToken: 'token-A', refresherToken: 'new-client' });
    loadClaudeCodeOauthTokenMock.mockReturnValue('token-B');

    await layer.forceClientRefresh();

    // Second refresh: store now returns B (still), so it should NOT be swapped.
    loadClaudeCodeOauthTokenMock.mockReturnValue('token-B');
    const second = await layer.forceClientRefresh();

    expect(second!.swapped).toBe(false);
  });
});
