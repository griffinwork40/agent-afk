/**
 * Unit tests for the Codex models-catalog reader.
 *
 * All tests use the dependency-injection surface so no real
 * `~/.codex/models_cache.json` is ever read.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadModelsCatalog,
  isCatalogModelPriorityEligible,
  resetCatalogCache,
} from './models-catalog.js';

// Minimal fixture that mirrors real catalog shape (identity field intentionally
// absent — the reader must never access it).
const FIXTURE_CATALOG = JSON.stringify({
  fetched_at: '2026-09-25T00:00:00Z',
  etag: 'abc123',
  client_version: '1.0.0',
  models: [
    {
      slug: 'gpt-6-sol',
      service_tiers: [{ id: 'priority', name: 'Priority', description: 'Fast priority tier' }],
      default_service_tier: 'default',
    },
    {
      slug: 'gpt-5.5',
      service_tiers: [{ id: 'priority', name: 'Priority' }],
      default_service_tier: 'default',
    },
    {
      slug: 'gpt-5.6-luna',
      service_tiers: [{ id: 'priority' }],
      default_service_tier: 'default',
    },
    {
      slug: 'gpt-4o-mini',
      service_tiers: [],
      default_service_tier: 'default',
    },
    {
      slug: 'uses-fast-alias',
      service_tiers: [{ id: 'fast' }],
      default_service_tier: 'default',
    },
  ],
});

const DEPS_WITH_CATALOG = {
  homedir: () => '/tmp/fake-home',
  readFile: (path: string) => (path.endsWith('models_cache.json') ? FIXTURE_CATALOG : null),
};

const DEPS_MISSING_FILE = {
  homedir: () => '/tmp/fake-home',
  readFile: () => null,
};

const DEPS_MALFORMED = {
  homedir: () => '/tmp/fake-home',
  readFile: () => '{ not valid json {{',
};

beforeEach(() => resetCatalogCache());

describe('loadModelsCatalog', () => {
  it('parses a valid catalog and indexes models by slug', () => {
    const catalog = loadModelsCatalog(DEPS_WITH_CATALOG);
    expect(catalog.size).toBeGreaterThanOrEqual(4);
    expect(catalog.has('gpt-6-sol')).toBe(true);
    expect(catalog.has('gpt-5.5')).toBe(true);
  });

  it('returns an empty map when the file is missing', () => {
    const catalog = loadModelsCatalog(DEPS_MISSING_FILE);
    expect(catalog.size).toBe(0);
  });

  it('returns an empty map on malformed JSON (never throws)', () => {
    const catalog = loadModelsCatalog(DEPS_MALFORMED);
    expect(catalog.size).toBe(0);
  });

  it('caches the result across calls (same Map instance)', () => {
    const first = loadModelsCatalog(DEPS_WITH_CATALOG);
    const second = loadModelsCatalog(DEPS_WITH_CATALOG);
    expect(second).toBe(first);
  });

  it('never includes identity field in parsed output', () => {
    const withIdentity = JSON.stringify({
      identity: { user_id: 'secret-123', email: 'user@example.com' },
      models: [{ slug: 'gpt-6-sol', service_tiers: [{ id: 'priority' }] }],
    });
    const deps = {
      homedir: () => '/tmp/fake-home',
      readFile: () => withIdentity,
    };
    const catalog = loadModelsCatalog(deps);
    // Should still parse the models fine
    expect(catalog.has('gpt-6-sol')).toBe(true);
    // identity is never surfaced in CatalogModel
    const entry = catalog.get('gpt-6-sol');
    expect(entry).not.toHaveProperty('identity');
  });
});

describe('isCatalogModelPriorityEligible', () => {
  it('returns true for a model with priority tier', () => {
    expect(isCatalogModelPriorityEligible('gpt-6-sol', DEPS_WITH_CATALOG)).toBe(true);
  });

  it('returns true for a model with the "fast" alias tier', () => {
    expect(isCatalogModelPriorityEligible('uses-fast-alias', DEPS_WITH_CATALOG)).toBe(true);
  });

  it('returns false for a model with empty service_tiers', () => {
    expect(isCatalogModelPriorityEligible('gpt-4o-mini', DEPS_WITH_CATALOG)).toBe(false);
  });

  it('returns undefined for a model absent from the catalog', () => {
    expect(isCatalogModelPriorityEligible('unknown-model-xyz', DEPS_WITH_CATALOG)).toBeUndefined();
  });

  it('returns undefined when the catalog file is missing', () => {
    expect(isCatalogModelPriorityEligible('gpt-6-sol', DEPS_MISSING_FILE)).toBeUndefined();
  });

  it('returns undefined on malformed JSON (never throws)', () => {
    expect(isCatalogModelPriorityEligible('gpt-6-sol', DEPS_MALFORMED)).toBeUndefined();
  });
});
