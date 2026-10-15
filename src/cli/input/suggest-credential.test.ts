/**
 * Tests for `src/cli/input/suggest-credential.ts`.
 *
 * Covers the memoization contract, the `undefined` sentinel, error propagation,
 * and the chatgpt-oauth vs plain-openai distinction (different binding.provider
 * values must get different cache entries; chatgpt-oauth must set
 * `forceChatgptOAuth: true`).
 *
 * All tests inject their own `resolveFn` and slot bindings — no real
 * credential reads, no env side-effects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSuggestCredentialResolver,
  type ResolveCredentialFn,
} from './suggest-credential.js';
import {
  setSlotBindings,
  resetSlotBindings,
  type ModelSlots,
} from '../../agent/session/model-slots.js';

// ── Slot binding helpers ──────────────────────────────────────────────────────

function makeSlots(
  overrides: Partial<ModelSlots> = {},
): ModelSlots {
  const defaults: ModelSlots = {
    local: { id: '' },
    small: { id: 'claude-haiku-4-5' },
    medium: { id: 'claude-sonnet-4-5' },
    large: { id: 'claude-opus-4-5' },
  };
  return { ...defaults, ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createSuggestCredentialResolver', () => {
  beforeEach(() => {
    // Reset process-global slot bindings so tests don't bleed into each other.
    resetSlotBindings();
  });

  // ── Cache hit: same provider kind returns memoized result ─────────────────

  it('returns the same resolved result on repeated calls (cache hit)', () => {
    const resolveFn = vi.fn<ResolveCredentialFn>(() => 'sk-test');
    const resolver = createSuggestCredentialResolver(resolveFn);

    const slots = makeSlots({ small: { id: 'gpt-4o', provider: 'openai' } });
    setSlotBindings(slots);

    const hints = { slots };
    const first = resolver.resolve('small', hints);
    const second = resolver.resolve('small', hints);

    expect(first).toEqual({ apiKey: 'sk-test' });
    expect(second).toEqual({ apiKey: 'sk-test' });
    // resolveFn must be called exactly once — the second call is served from cache.
    expect(resolveFn).toHaveBeenCalledTimes(1);
  });

  // ── undefined sentinel: no credential is also cached ─────────────────────

  it('caches and returns undefined when resolveFn returns undefined', () => {
    const resolveFn = vi.fn<ResolveCredentialFn>(() => undefined);
    const resolver = createSuggestCredentialResolver(resolveFn);

    const slots = makeSlots({ medium: { id: 'gpt-4o-mini', provider: 'openai' } });
    setSlotBindings(slots);

    const hints = { slots };
    const first = resolver.resolve('medium', hints);
    const second = resolver.resolve('medium', hints);

    // No credential → result is undefined.
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    // resolveFn still called once; cache serves the sentinel on second call.
    expect(resolveFn).toHaveBeenCalledTimes(1);
  });

  // ── Error propagation: resolveFn throw must not be swallowed ──────────────

  it('propagates an error thrown by resolveFn', () => {
    const boom = new Error('keychain locked');
    const resolveFn = vi.fn<ResolveCredentialFn>(() => { throw boom; });
    const resolver = createSuggestCredentialResolver(resolveFn);

    const slots = makeSlots({ large: { id: 'gpt-4o', provider: 'openai' } });
    setSlotBindings(slots);

    expect(() => resolver.resolve('large', { slots })).toThrow('keychain locked');
  });

  // ── chatgpt-oauth vs openai: distinct cache entries, forceChatgptOAuth ────

  it('sets forceChatgptOAuth on chatgpt-oauth binding', () => {
    const resolveFn = vi.fn<ResolveCredentialFn>(() => undefined);
    const resolver = createSuggestCredentialResolver(resolveFn);

    const slots = makeSlots({
      small: { id: 'gpt-4o', provider: 'chatgpt-oauth' },
    });
    setSlotBindings(slots);

    const result = resolver.resolve('small', { slots });
    expect(result).toEqual({ forceChatgptOAuth: true });
  });

  it('does NOT set forceChatgptOAuth for a plain openai binding', () => {
    const resolveFn = vi.fn<ResolveCredentialFn>(() => 'sk-openai');
    const resolver = createSuggestCredentialResolver(resolveFn);

    const slots = makeSlots({
      small: { id: 'gpt-4o', provider: 'openai' },
    });
    setSlotBindings(slots);

    const result = resolver.resolve('small', { slots });
    expect(result).toEqual({ apiKey: 'sk-openai' });
    expect(result).not.toHaveProperty('forceChatgptOAuth');
  });

  it('gives chatgpt-oauth and plain openai separate cache entries', () => {
    let callCount = 0;
    const resolveFn = vi.fn<ResolveCredentialFn>(() => {
      callCount++;
      return callCount === 1 ? undefined : 'sk-openai';
    });
    const resolver = createSuggestCredentialResolver(resolveFn);

    const slotsOauth = makeSlots({
      small: { id: 'gpt-4o', provider: 'chatgpt-oauth' },
    });
    const slotsOpenai = makeSlots({
      medium: { id: 'gpt-4o', provider: 'openai' },
    });

    // Resolve chatgpt-oauth slot
    setSlotBindings(slotsOauth);
    const oauthResult = resolver.resolve('small', { slots: slotsOauth });

    // Resolve plain openai slot (different binding.provider → different cache key)
    setSlotBindings(slotsOpenai);
    const openaiResult = resolver.resolve('medium', { slots: slotsOpenai });

    // chatgpt-oauth: forceChatgptOAuth, no apiKey (resolveFn returned undefined first call)
    expect(oauthResult).toEqual({ forceChatgptOAuth: true });
    // plain openai: apiKey, no forceChatgptOAuth
    expect(openaiResult).toEqual({ apiKey: 'sk-openai' });

    // resolveFn was called once per distinct provider kind
    expect(resolveFn).toHaveBeenCalledTimes(2);
  });

  // ── chatgpt-oauth WITH an apiKey: both fields set ─────────────────────────

  it('sets both apiKey and forceChatgptOAuth when chatgpt-oauth binding has a key', () => {
    const resolveFn = vi.fn<ResolveCredentialFn>(() => 'sk-chatgpt');
    const resolver = createSuggestCredentialResolver(resolveFn);

    const slots = makeSlots({
      large: { id: 'gpt-4o', provider: 'chatgpt-oauth' },
    });
    setSlotBindings(slots);

    const result = resolver.resolve('large', { slots });
    expect(result).toEqual({ apiKey: 'sk-chatgpt', forceChatgptOAuth: true });
  });
});
