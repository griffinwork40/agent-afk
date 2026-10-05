/**
 * Unit tests for the OpenAI fast-mode helper module.
 *
 * Covers:
 *   - snapshotFastDecision: top-level eligibility, custom-endpoint exclusion,
 *     catalog/fallback model routing.
 *   - isFastModeServiceTierError: 400 latch detection.
 *   - extractResponsesServiceTier / extractChatCompletionsServiceTier.
 *   - makeFastModeMismatchWarning.
 */

import { describe, it, expect } from 'vitest';
import { FastModeController } from '../../../fast-mode.js';
import { resetCatalogCache } from '../models-catalog.js';
import {
  snapshotFastDecision,
  isFastModeServiceTierError,
  extractResponsesServiceTier,
  extractChatCompletionsServiceTier,
  makeFastModeMismatchWarning,
} from './fast-mode.js';
import type { CatalogReaderDeps } from '../models-catalog.js';

// ── snapshotFastDecision ──────────────────────────────────────────────────────

describe('snapshotFastDecision', () => {
  it('returns undefined when no controller is provided', () => {
    expect(snapshotFastDecision(undefined, 'gpt-6-sol', false)).toBeUndefined();
  });

  it('returns effective=false when preference is off', () => {
    const ctrl = new FastModeController('off');
    const d = snapshotFastDecision(ctrl, 'gpt-6-sol', false);
    expect(d?.effective).toBe(false);
    expect(d?.reason).toBe('preference-off');
  });

  it('returns effective=true for an eligible model at top-level', () => {
    const ctrl = new FastModeController('on');
    const d = snapshotFastDecision(ctrl, 'gpt-6-sol', false);
    expect(d?.effective).toBe(true);
  });

  it('returns effective=false for a custom endpoint', () => {
    const ctrl = new FastModeController('on');
    const d = snapshotFastDecision(ctrl, 'gpt-6-sol', true);
    expect(d?.effective).toBe(false);
    expect(d?.reason).toBe('custom-endpoint');
  });

  it('returns effective=false for a non-fast model', () => {
    const ctrl = new FastModeController('on');
    const d = snapshotFastDecision(ctrl, 'gpt-4o', false);
    expect(d?.effective).toBe(false);
    expect(d?.reason).toBe('unsupported-model');
  });

  it('uses catalog eligibility when catalog lists the model', () => {
    resetCatalogCache();
    // The 4th parameter (`catalogDeps`) lets callers inject a fake catalog reader;
    // this test exercises the regex fallback path for a model not in a catalog file.
    // For catalog-injection tests, see the 'catalog-override path' cases below.
    const ctrl = new FastModeController('on');
    // gpt-5.5 is in the fallback regex
    const d = snapshotFastDecision(ctrl, 'gpt-5.5', false);
    expect(d?.effective).toBe(true);
  });

  it('catalog-override path: catalog eligible=true overrides the fallback for a non-regex model', () => {
    resetCatalogCache();
    const ctrl = new FastModeController('on');
    // gpt-4o is NOT in the fallback regex (would return unsupported-model).
    // Inject a catalog that marks it as priority-eligible.
    const fakeCatalog = JSON.stringify({
      models: [{ slug: 'gpt-4o', service_tiers: [{ id: 'priority' }] }],
    });
    const deps: CatalogReaderDeps = {
      homedir: () => '/fake-home',
      readFile: () => fakeCatalog,
    };
    const d = snapshotFastDecision(ctrl, 'gpt-4o', false, deps);
    expect(d?.effective).toBe(true);
  });

  it('catalog-override path: catalog eligible=false overrides the fallback for a regex-matching model', () => {
    resetCatalogCache();
    const ctrl = new FastModeController('on');
    // gpt-5.5 IS in the fallback regex (would return effective=true without catalog).
    // Inject a catalog that explicitly marks it as NOT priority-eligible.
    const fakeCatalog = JSON.stringify({
      models: [{ slug: 'gpt-5.5', service_tiers: [{ id: 'default' }] }],
    });
    const deps: CatalogReaderDeps = {
      homedir: () => '/fake-home',
      readFile: () => fakeCatalog,
    };
    const d = snapshotFastDecision(ctrl, 'gpt-5.5', false, deps);
    expect(d?.effective).toBe(false);
    expect(d?.reason).toBe('unsupported-model');
  });
});

// ── isFastModeServiceTierError ────────────────────────────────────────────────

describe('isFastModeServiceTierError', () => {
  it('returns true for HTTP 400 mentioning service_tier', () => {
    const err = { status: 400, message: 'Invalid field: service_tier' };
    expect(isFastModeServiceTierError(err)).toBe(true);
  });

  it('returns false for HTTP 400 mentioning "priority" but NOT service_tier', () => {
    // A 400 about an unrelated "priority" field must NOT trigger the fast-mode latch.
    // Only an explicit service_tier mention indicates the right rejection.
    const err = { status: 400, message: 'Field "priority" is not supported' };
    expect(isFastModeServiceTierError(err)).toBe(false);
  });

  it('returns false for HTTP 400 NOT mentioning service_tier/priority', () => {
    const err = { status: 400, message: 'Invalid model id' };
    expect(isFastModeServiceTierError(err)).toBe(false);
  });

  it('returns false for non-400 HTTP errors', () => {
    const err = { status: 429, message: 'service_tier rate limit' };
    expect(isFastModeServiceTierError(err)).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isFastModeServiceTierError(null)).toBe(false);
    expect(isFastModeServiceTierError('string')).toBe(false);
    expect(isFastModeServiceTierError(42)).toBe(false);
  });

  it('checks nested error.message too', () => {
    const err = { status: 400, message: '', error: { message: 'bad service_tier' } };
    expect(isFastModeServiceTierError(err)).toBe(true);
  });
});

// ── extractResponsesServiceTier ───────────────────────────────────────────────

describe('extractResponsesServiceTier', () => {
  it('extracts service_tier from a response object', () => {
    expect(extractResponsesServiceTier({ service_tier: 'priority' })).toBe('priority');
  });

  it('extracts the default tier', () => {
    expect(extractResponsesServiceTier({ service_tier: 'default' })).toBe('default');
  });

  it('returns undefined when field is absent', () => {
    expect(extractResponsesServiceTier({})).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(extractResponsesServiceTier(null)).toBeUndefined();
    expect(extractResponsesServiceTier(undefined)).toBeUndefined();
  });
});

// ── extractChatCompletionsServiceTier ────────────────────────────────────────

describe('extractChatCompletionsServiceTier', () => {
  it('extracts service_tier from a chunk', () => {
    expect(extractChatCompletionsServiceTier({ service_tier: 'priority', usage: {} })).toBe('priority');
  });

  it('returns undefined when field is absent', () => {
    expect(extractChatCompletionsServiceTier({ usage: {} })).toBeUndefined();
  });

  it('returns undefined for null/undefined input', () => {
    expect(extractChatCompletionsServiceTier(null)).toBeUndefined();
  });
});

// ── makeFastModeMismatchWarning ───────────────────────────────────────────────

describe('makeFastModeMismatchWarning', () => {
  it('returns undefined when fast=false', () => {
    expect(makeFastModeMismatchWarning(false, 'default')).toBeUndefined();
  });

  it('returns undefined when applied tier matches (priority)', () => {
    expect(makeFastModeMismatchWarning(true, 'priority')).toBeUndefined();
  });

  it('returns undefined when applied tier is undefined', () => {
    expect(makeFastModeMismatchWarning(true, undefined)).toBeUndefined();
  });

  it('returns a warning string when applied tier is "default" (downgraded)', () => {
    const msg = makeFastModeMismatchWarning(true, 'default');
    expect(msg).toBeTypeOf('string');
    expect(msg).toContain('priority');
    expect(msg).toContain('default');
  });

  it('warning names the applied tier and says the turn ran at standard speed', () => {
    const msg = makeFastModeMismatchWarning(true, 'default');
    expect(msg).toContain('"default"');
    expect(msg).toContain('standard speed');
  });

  it('treats an echoed "fast" alias as confirmed (no warning)', () => {
    expect(makeFastModeMismatchWarning(true, 'fast')).toBeUndefined();
  });
});
