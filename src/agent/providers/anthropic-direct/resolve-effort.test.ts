/**
 * Unit tests for `resolveEffort` and the model-aware `resolveThinkingParam`
 * logic in the `anthropic-direct` provider.
 *
 * `resolveEffort` auto-defaults to `'max'` on the production-verified
 * allowlist (`opus-4-6`, `opus-4-7`, `opus-4-8`, `sonnet-4-6`, `sonnet-4-7`)
 * and passes explicit values through unchanged for all models. Older 4-x
 * variants and Haiku return HTTP 400 when `output_config.effort` is set, so
 * the auto-default is gated to known-good ids; explicit overrides still flow
 * through unchanged to fail loudly rather than silently ignore.
 */

import { describe, it, expect } from 'vitest';
import { resolveEffort } from './index.js';

describe('resolveEffort', () => {
  // ── Auto-default to "max" on the allowlist ─────────────────────────────

  it('defaults to "max" for claude-opus-4-8 (any suffix)', () => {
    // Lock in: on opus-4-8 the server's default effort flipped to `high`.
    // We override with `max` to preserve the high-thinking-depth experience
    // users had on 4.7. See the resolveEffort docstring rule 2.
    expect(resolveEffort(undefined, 'claude-opus-4-8')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-8-20260528')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-8-latest')).toBe('max');
  });

  it('defaults to "max" for claude-opus-4-7 (any suffix)', () => {
    expect(resolveEffort(undefined, 'claude-opus-4-7-20250901')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-7-latest')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-7')).toBe('max');
  });

  it('defaults to "max" for claude-opus-4-6 (any suffix)', () => {
    expect(resolveEffort(undefined, 'claude-opus-4-6')).toBe('max');
    expect(resolveEffort(undefined, 'claude-opus-4-6-20250901')).toBe('max');
  });

  it('defaults to "max" for claude-sonnet-4-6 and 4-7', () => {
    expect(resolveEffort(undefined, 'claude-sonnet-4-6')).toBe('max');
    expect(resolveEffort(undefined, 'claude-sonnet-4-6-20250901')).toBe('max');
    expect(resolveEffort(undefined, 'claude-sonnet-4-7-latest')).toBe('max');
  });

  // ── Explicit caller overrides always win ───────────────────────────────

  it('returns the explicit effort when caller specifies it, even on opus-4-7', () => {
    expect(resolveEffort('low', 'claude-opus-4-7-20250901')).toBe('low');
    expect(resolveEffort('medium', 'claude-opus-4-7-20250901')).toBe('medium');
    expect(resolveEffort('high', 'claude-opus-4-7-20250901')).toBe('high');
    expect(resolveEffort('max', 'claude-opus-4-7-20250901')).toBe('max');
  });

  it('passes explicit effort through on models that would otherwise omit it', () => {
    // Caller's explicit value flows through even where auto-default would
    // skip the field — so the API can return its own 400 if the model
    // genuinely does not support effort, rather than us silently dropping
    // the override.
    expect(resolveEffort('high', 'claude-sonnet-4-5-20250929')).toBe('high');
    expect(resolveEffort('low', 'claude-haiku-4-5-20250929')).toBe('low');
    expect(resolveEffort('max', 'claude-opus-4-1-20250805')).toBe('max');
  });

  // ── Models off the allowlist: no auto-default ─────────────────────────

  it('returns undefined for older 4-x variants (which reject effort with HTTP 400)', () => {
    expect(resolveEffort(undefined, 'claude-sonnet-4-5-20250929')).toBeUndefined();
    expect(resolveEffort(undefined, 'claude-sonnet-4-5')).toBeUndefined();
    expect(resolveEffort(undefined, 'claude-opus-4-1-20250805')).toBeUndefined();
  });

  it('returns undefined for every Haiku (Haiku rejects effort)', () => {
    expect(resolveEffort(undefined, 'claude-haiku-4-5-20251001')).toBeUndefined();
    expect(resolveEffort(undefined, 'claude-haiku-4-5')).toBeUndefined();
  });

  it('returns undefined for 3.x and unknown ids', () => {
    expect(resolveEffort(undefined, 'claude-3-5-sonnet-20241022')).toBeUndefined();
    expect(resolveEffort(undefined, 'some-mystery-model')).toBeUndefined();
  });
});
