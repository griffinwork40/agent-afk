/**
 * Unit tests for the catalog-backed capability lookups. Every case pins the
 * catalog through `useCodexCatalog`, so no real `~/.codex` file is read.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  catalogContextWindow,
  catalogEntryFor,
  catalogIsReasoningModel,
  catalogSupportsImages,
} from './models-catalog.capabilities.js';
import { resetCatalogCache } from './models-catalog.js';
import { useCodexCatalog } from '../../../__test-utils__/codex-catalog.js';

// Shapes copied from a real models_cache.json (2026-10 refresh).
const FIXTURE = [
  {
    slug: 'gpt-6-sol',
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'low', description: 'x' }, { effort: 'high', description: 'y' }],
    context_window: 272000,
  },
  { slug: 'text-only-model', input_modalities: ['text'], supported_reasoning_levels: [], context_window: 128000 },
  { slug: 'bare-entry' },
  { slug: 'mangled', input_modalities: 'image', supported_reasoning_levels: {}, context_window: -5 },
];

describe('models-catalog capability lookups', () => {
  beforeEach(() => useCodexCatalog(FIXTURE));
  afterAll(() => resetCatalogCache());

  it('reads image input from input_modalities', () => {
    expect(catalogSupportsImages('gpt-6-sol')).toBe(true);
    expect(catalogSupportsImages('text-only-model')).toBe(false);
  });

  it('reads the reasoning contract from supported_reasoning_levels', () => {
    expect(catalogIsReasoningModel('gpt-6-sol')).toBe(true);
    expect(catalogIsReasoningModel('text-only-model')).toBe(false);
    expect(catalogEntryFor('gpt-6-sol')?.supported_reasoning_levels).toEqual(['low', 'high']);
  });

  it('reads context_window', () => {
    expect(catalogContextWindow('gpt-6-sol')).toBe(272000);
    expect(catalogContextWindow('text-only-model')).toBe(128000);
  });

  it('returns undefined (no opinion) when the field is missing or malformed', () => {
    for (const slug of ['bare-entry', 'mangled']) {
      expect(catalogSupportsImages(slug), slug).toBeUndefined();
      expect(catalogIsReasoningModel(slug), slug).toBeUndefined();
      expect(catalogContextWindow(slug), slug).toBeUndefined();
    }
  });

  it('returns undefined for models absent from the catalog', () => {
    expect(catalogSupportsImages('claude-opus-5-5')).toBeUndefined();
    expect(catalogIsReasoningModel(undefined)).toBeUndefined();
    expect(catalogContextWindow('')).toBeUndefined();
  });

  it('matches case-insensitively and ignores a known provider/ prefix', () => {
    expect(catalogSupportsImages('GPT-6-SOL')).toBe(true);
    expect(catalogSupportsImages('openai/gpt-6-sol')).toBe(true);
    expect(catalogContextWindow('  gpt-6-sol  ')).toBe(272000);
  });

  it('does NOT strip arbitrary org prefixes — acme/gpt-6-sol must not inherit gpt-6-sol', () => {
    // Only known prefixes (openai/, openrouter/) are stripped. An arbitrary
    // org prefix like acme/ must not inherit the gpt-6-sol entry.
    expect(catalogSupportsImages('acme/gpt-6-sol')).toBeUndefined();
    expect(catalogIsReasoningModel('acme/gpt-6-sol')).toBeUndefined();
  });

  it('returns undefined for everything when no catalog file exists', () => {
    useCodexCatalog(null);
    expect(catalogSupportsImages('gpt-6-sol')).toBeUndefined();
    expect(catalogIsReasoningModel('gpt-6-sol')).toBeUndefined();
    expect(catalogContextWindow('gpt-6-sol')).toBeUndefined();
  });
});
