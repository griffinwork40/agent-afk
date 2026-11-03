/**
 * Unit tests for the shared low-level helpers in model-slots.utils.ts.
 *
 * These helpers were extracted from inline copies to eliminate duplication
 * flagged in #4120.  The tests here are the dedicated coverage requested in
 * the advisory findings for PR #4143 (issue #4218).
 */

import { describe, it, expect } from 'vitest';
import { normalizeSlotProvider, parseStringField } from './model-slots.utils.js';

// ---------------------------------------------------------------------------
// normalizeSlotProvider
// ---------------------------------------------------------------------------

describe('normalizeSlotProvider', () => {
  it('returns undefined for non-string input', () => {
    expect(normalizeSlotProvider(undefined)).toBeUndefined();
    expect(normalizeSlotProvider(null)).toBeUndefined();
    expect(normalizeSlotProvider(42)).toBeUndefined();
    expect(normalizeSlotProvider({})).toBeUndefined();
  });

  it('maps "anthropic" variants to "anthropic"', () => {
    expect(normalizeSlotProvider('anthropic')).toBe('anthropic');
    expect(normalizeSlotProvider('Anthropic')).toBe('anthropic');
    expect(normalizeSlotProvider('ANTHROPIC')).toBe('anthropic');
    expect(normalizeSlotProvider('anthropic-direct')).toBe('anthropic');
    expect(normalizeSlotProvider('  anthropic  ')).toBe('anthropic');
  });

  it('maps "openai" variants to "openai"', () => {
    expect(normalizeSlotProvider('openai')).toBe('openai');
    expect(normalizeSlotProvider('OpenAI')).toBe('openai');
    expect(normalizeSlotProvider('openai-compatible')).toBe('openai');
  });

  it('maps "chatgpt-oauth" variants to "chatgpt-oauth"', () => {
    expect(normalizeSlotProvider('chatgpt-oauth')).toBe('chatgpt-oauth');
    expect(normalizeSlotProvider('chatgpt')).toBe('chatgpt-oauth');
    expect(normalizeSlotProvider('ChatGPT')).toBe('chatgpt-oauth');
  });

  it('maps "xai" to "xai"', () => {
    expect(normalizeSlotProvider('xai')).toBe('xai');
    expect(normalizeSlotProvider('XAI')).toBe('xai');
  });

  it('maps "xai-oauth" variants to "xai-oauth"', () => {
    expect(normalizeSlotProvider('xai-oauth')).toBe('xai-oauth');
    expect(normalizeSlotProvider('xai_oauth')).toBe('xai-oauth');
  });

  it('returns undefined for unrecognised strings', () => {
    expect(normalizeSlotProvider('unknown')).toBeUndefined();
    expect(normalizeSlotProvider('')).toBeUndefined();
    expect(normalizeSlotProvider('gemini')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseStringField
// ---------------------------------------------------------------------------

describe('parseStringField', () => {
  it('returns empty string for non-string input', () => {
    expect(parseStringField(undefined)).toBe('');
    expect(parseStringField(null)).toBe('');
    expect(parseStringField(42)).toBe('');
    expect(parseStringField({})).toBe('');
    expect(parseStringField([])).toBe('');
  });

  it('returns the trimmed string for string input', () => {
    expect(parseStringField('hello')).toBe('hello');
    expect(parseStringField('  hello  ')).toBe('hello');
    expect(parseStringField('')).toBe('');
    expect(parseStringField('   ')).toBe('');
  });
});
