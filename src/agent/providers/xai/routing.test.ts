/**
 * Routing + force-mode tests for the xAI provider family.
 * Avoid importing resolveProvider (loads MemoryStore / better-sqlite3).
 */

import { describe, it, expect } from 'vitest';
import { providerForModel } from '../index.js';
import {
  resolveCompleteForceMode,
  resolveXaiConstructionAuthMode,
  resolveXaiForceMode,
} from './force-mode.js';

describe('providerForModel — grok / xai', () => {
  it('routes grok-* to xai', () => {
    expect(providerForModel('grok-4', { explicit: undefined })).toBe('xai');
    expect(providerForModel('grok-4.5', {})).toBe('xai');
    expect(providerForModel('grok_2', {})).toBe('xai');
  });

  it('honors explicit xai-oauth', () => {
    expect(providerForModel('grok-4', { explicit: 'xai-oauth' })).toBe('xai-oauth');
  });

  it('honors explicit xai', () => {
    expect(providerForModel('claude-sonnet-4-6', { explicit: 'xai' })).toBe('xai');
  });

  it('does not steal gpt models', () => {
    expect(providerForModel('gpt-4o', {})).toBe('openai-compatible');
  });
});

describe('resolveXaiForceMode', () => {
  it('config forceXaiOAuth wins', () => {
    expect(resolveXaiForceMode('apikey', true)).toBe('oauth');
  });

  it('config forceXaiApiKey forces apikey', () => {
    expect(resolveXaiForceMode(undefined, false, true)).toBe('apikey');
  });

  it('oauth force wins over apikey force', () => {
    expect(resolveXaiForceMode(undefined, true, true)).toBe('oauth');
  });

  it('construction mode applies when no config force', () => {
    expect(resolveXaiForceMode('apikey', false)).toBe('apikey');
    expect(resolveXaiForceMode('oauth', false)).toBe('oauth');
    expect(resolveXaiForceMode(undefined, false)).toBeUndefined();
  });
});

describe('resolveCompleteForceMode — complete() slot parity', () => {
  it('reuses last query() mode so slot force survives oneshot path', () => {
    // Dual-cred auto construction + slot-forced oauth on last query.
    expect(resolveCompleteForceMode(undefined, 'oauth')).toBe('oauth');
    expect(resolveCompleteForceMode(undefined, 'apikey')).toBe('apikey');
  });

  it('falls back to construction force before any query', () => {
    expect(resolveCompleteForceMode('oauth', undefined)).toBe('oauth');
    expect(resolveCompleteForceMode('apikey', undefined)).toBe('apikey');
    expect(resolveCompleteForceMode(undefined, undefined)).toBeUndefined();
  });

  it('last resolved wins over construction mode', () => {
    // Session started with --provider xai then switched via slots.
    expect(resolveCompleteForceMode('apikey', 'oauth')).toBe('oauth');
  });
});

describe('resolveXaiConstructionAuthMode — parseProvider parity', () => {
  it('auto-routed xai leaves mode undefined (OAuth-only happy path)', () => {
    expect(resolveXaiConstructionAuthMode('xai', false)).toBeUndefined();
  });

  it('explicit xai forces apikey', () => {
    expect(resolveXaiConstructionAuthMode('xai', true)).toBe('apikey');
  });

  it('xai-oauth always forces oauth (explicit or routed name)', () => {
    expect(resolveXaiConstructionAuthMode('xai-oauth', false)).toBe('oauth');
    expect(resolveXaiConstructionAuthMode('xai-oauth', true)).toBe('oauth');
  });
});
