/** Unit tests for deriveCredentialFromStore — provenance derivation logic. */
import { describe, expect, it } from 'vitest';
import { deriveCredentialFromStore } from './provider-query-setup.credential.js';

const storeToken = 'tok-store';
const slotToken = 'sk-ant-oat01-slot-pinned-token';
const apiKeyToken = 'sk-ant-api03-not-oauth';

describe('deriveCredentialFromStore', () => {
  it('returns false when tokenRefresher is not installed (api-key or localMode session)', () => {
    expect(deriveCredentialFromStore(storeToken, false, () => storeToken)).toBe(false);
  });

  it('returns true when tokenRefresher installed and token matches the store', () => {
    expect(deriveCredentialFromStore(storeToken, true, () => storeToken)).toBe(true);
  });

  it('returns false when tokenRefresher installed but token is a slot-pinned OAuth key', () => {
    // authMode detects slotToken as oauth → tokenRefresher would be installed,
    // but the token differs from the store → not store-sourced.
    expect(deriveCredentialFromStore(slotToken, true, () => storeToken)).toBe(false);
  });

  it('returns false when tokenRefresher installed but token is api-key-shaped', () => {
    expect(deriveCredentialFromStore(apiKeyToken, true, () => storeToken)).toBe(false);
  });

  it('returns false (conservative) when store is unreadable (readStore returns undefined)', () => {
    // If the keychain is unreadable loadClaudeCodeOauthToken returns undefined.
    // Conservative outcome: no auto-swap.
    expect(deriveCredentialFromStore(storeToken, true, () => undefined)).toBe(false);
  });
});
