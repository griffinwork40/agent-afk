import { describe, it, expect } from 'vitest';
import { cliProviderFamily, selectCliProvider } from './provider-selection.js';

describe('selectCliProvider', () => {
  it('returns undefined when raw and model are both absent', () => {
    expect(selectCliProvider(undefined)).toBeUndefined();
  });

  it('passes through known providers unchanged', () => {
    expect(selectCliProvider('openai-compatible')).toBe('openai-compatible');
    expect(selectCliProvider('openai-codex')).toBe('openai-codex');
    expect(selectCliProvider('anthropic-direct')).toBe('anthropic-direct');
    expect(selectCliProvider('xai')).toBe('xai');
  });

  it('throws on an unknown provider value', () => {
    expect(() => selectCliProvider('bogus')).toThrow('Invalid --provider value');
  });
});

describe('cliProviderFamily', () => {
  it('maps openai to openai-compatible', () => {
    expect(cliProviderFamily('openai')).toBe('openai-compatible');
  });

  it('maps openai-compatible to openai-compatible', () => {
    expect(cliProviderFamily('openai-compatible')).toBe('openai-compatible');
  });

  it('maps legacy openai-codex alias to openai-compatible', () => {
    // Backward-compat: existing scripts that pass --provider openai-codex
    // must not be routed to the Anthropic credential gate.
    expect(cliProviderFamily('openai-codex')).toBe('openai-compatible');
  });

  it('maps xai and xai-oauth through unchanged', () => {
    expect(cliProviderFamily('xai')).toBe('xai');
    expect(cliProviderFamily('xai-oauth')).toBe('xai-oauth');
  });

  it('defaults to anthropic-direct when nothing is specified', () => {
    expect(cliProviderFamily(undefined)).toBe('anthropic-direct');
  });

  it('defaults to anthropic-direct for anthropic-direct explicit', () => {
    expect(cliProviderFamily('anthropic-direct')).toBe('anthropic-direct');
  });
});
