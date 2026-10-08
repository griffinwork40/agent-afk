/**
 * Tests for the plugin index store. Uses a tmpdir for isolation; every helper
 * takes an explicit path so we never touch the real ~/.afk/plugins/.index.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readIndex,
  writeIndex,
  upsertPlugin,
  removePlugin,
  setEnabled,
  upsertMarketplace,
  removeMarketplace,
  type PluginIndexEntry,
  type MarketplaceIndexEntry,
  type PluginIndex,
} from './index-store.js';

let tmpDir: string;
let indexPath: string;

function sampleEntry(overrides: Partial<PluginIndexEntry> = {}): PluginIndexEntry {
  return {
    source: 'anthropics/example',
    sourceType: 'github',
    ref: 'v1.0.0',
    commit: 'abc123',
    enabled: true,
    installedAt: '2026-04-20T12:00:00.000Z',
    updatedAt: '2026-04-20T12:00:00.000Z',
    ...overrides,
  };
}

function sampleMarketplace(overrides: Partial<MarketplaceIndexEntry> = {}): MarketplaceIndexEntry {
  return {
    source: 'anthropics/marketplace-example',
    sourceType: 'github',
    ref: 'v1.0.0',
    commit: 'def456',
    installedAt: '2026-04-20T12:00:00.000Z',
    updatedAt: '2026-04-20T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  indexPath = join(tmpDir, '.index.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('readIndex', () => {
  it('returns an empty v2 index when the file is missing', () => {
    const idx = readIndex(indexPath);
    expect(idx).toEqual({ version: 2, plugins: {}, marketplaces: {} });
  });

  it('returns an empty index when the file is malformed', () => {
    writeFileSync(indexPath, 'not json at all');
    expect(readIndex(indexPath)).toEqual({ version: 2, plugins: {}, marketplaces: {} });
  });

  it('returns an empty index when version is unknown', () => {
    writeFileSync(indexPath, JSON.stringify({ version: 99, plugins: { x: {} } }));
    expect(readIndex(indexPath)).toEqual({ version: 2, plugins: {}, marketplaces: {} });
  });

  it('auto-promotes v1 files to v2 with empty marketplaces', () => {
    writeFileSync(
      indexPath,
      JSON.stringify({ version: 1, plugins: { foo: sampleEntry() } }),
    );
    expect(readIndex(indexPath)).toEqual({
      version: 2,
      plugins: { foo: sampleEntry() },
      marketplaces: {},
    });
  });

  it('round-trips entries through writeIndex', () => {
    const idx: PluginIndex = {
      version: 2,
      plugins: { foo: sampleEntry() },
      marketplaces: { bar: sampleMarketplace() },
    };
    writeIndex(idx, indexPath);
    expect(readIndex(indexPath)).toEqual(idx);
  });
});

describe('writeIndex atomicity', () => {
  it('creates parent dirs if they do not exist', () => {
    const nested = join(tmpDir, 'deeper', 'still', '.index.json');
    writeIndex(
      { version: 2, plugins: { a: sampleEntry() }, marketplaces: {} },
      nested,
    );
    expect(existsSync(nested)).toBe(true);
  });

  it('leaves no stray .tmp file after a successful write', () => {
    writeIndex(
      { version: 2, plugins: { a: sampleEntry() }, marketplaces: {} },
      indexPath,
    );
    const siblings = readdirSync(tmpDir);
    expect(siblings.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('writes pretty-printed JSON', () => {
    writeIndex(
      { version: 2, plugins: { a: sampleEntry() }, marketplaces: {} },
      indexPath,
    );
    const text = readFileSync(indexPath, 'utf8');
    expect(text).toContain('\n');
    expect(text).toContain('  ');
  });
});

describe('upsertMarketplace / removeMarketplace', () => {
  it('upserts and reads back a marketplace entry', () => {
    upsertMarketplace('alpha', sampleMarketplace(), indexPath);
    expect(readIndex(indexPath).marketplaces.alpha).toEqual(sampleMarketplace());
  });

  it('overwrites existing marketplace entries', () => {
    upsertMarketplace('alpha', sampleMarketplace({ ref: 'v1.0.0' }), indexPath);
    upsertMarketplace('alpha', sampleMarketplace({ ref: 'v2.0.0' }), indexPath);
    expect(readIndex(indexPath).marketplaces.alpha.ref).toBe('v2.0.0');
  });

  it('cascades plugin entries that came from the removed marketplace', () => {
    upsertMarketplace('mp1', sampleMarketplace(), indexPath);
    upsertPlugin(
      'mp1:foo',
      sampleEntry({ sourceType: 'marketplace', marketplace: 'mp1' }),
      indexPath,
    );
    upsertPlugin(
      'mp1:bar',
      sampleEntry({ sourceType: 'marketplace', marketplace: 'mp1' }),
      indexPath,
    );
    upsertPlugin('standalone', sampleEntry(), indexPath);

    removeMarketplace('mp1', indexPath);

    const idx = readIndex(indexPath);
    expect(idx.marketplaces.mp1).toBeUndefined();
    expect(idx.plugins['mp1:foo']).toBeUndefined();
    expect(idx.plugins['mp1:bar']).toBeUndefined();
    expect(idx.plugins.standalone).toBeDefined();
  });

  it('is a no-op when the marketplace is absent', () => {
    removeMarketplace('ghost', indexPath);
    expect(readIndex(indexPath).marketplaces).toEqual({});
  });
});

describe('upsertPlugin', () => {
  it('inserts a new entry', () => {
    upsertPlugin('alpha', sampleEntry(), indexPath);
    expect(readIndex(indexPath).plugins.alpha).toEqual(sampleEntry());
  });

  it('overwrites an existing entry', () => {
    upsertPlugin('alpha', sampleEntry({ ref: 'v1.0.0' }), indexPath);
    upsertPlugin('alpha', sampleEntry({ ref: 'v2.0.0' }), indexPath);
    expect(readIndex(indexPath).plugins.alpha.ref).toBe('v2.0.0');
  });
});

describe('removePlugin', () => {
  it('is a no-op when the plugin is absent', () => {
    removePlugin('ghost', indexPath);
    expect(readIndex(indexPath).plugins).toEqual({});
  });

  it('removes an existing entry', () => {
    upsertPlugin('alpha', sampleEntry(), indexPath);
    upsertPlugin('beta', sampleEntry(), indexPath);
    removePlugin('alpha', indexPath);
    const idx = readIndex(indexPath);
    expect(idx.plugins.alpha).toBeUndefined();
    expect(idx.plugins.beta).toBeDefined();
  });
});

describe('setEnabled', () => {
  it('flips the enabled flag', () => {
    upsertPlugin('alpha', sampleEntry({ enabled: true }), indexPath);
    setEnabled('alpha', false, indexPath);
    expect(readIndex(indexPath).plugins.alpha.enabled).toBe(false);
  });

  it('updates updatedAt when toggled', () => {
    upsertPlugin(
      'alpha',
      sampleEntry({ enabled: true, updatedAt: '2020-01-01T00:00:00.000Z' }),
      indexPath,
    );
    setEnabled('alpha', false, indexPath);
    const entry = readIndex(indexPath).plugins.alpha;
    expect(entry.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('throws when the plugin is unknown', () => {
    expect(() => setEnabled('missing', true, indexPath)).toThrow(/not in the index/);
  });
});


// ---------------------------------------------------------------------------
// pinnedRef tests (fix #2358)
// ---------------------------------------------------------------------------

import { isPinnedRef, isMarketplacePinnedRef } from './index-store.js';

describe('isPinnedRef', () => {
  it('returns true when pinnedRef is explicitly true', () => {
    expect(isPinnedRef({ ref: 'afk', pinnedRef: true }, 'main')).toBe(true);
  });

  it('returns false when pinnedRef is explicitly false', () => {
    expect(isPinnedRef({ ref: 'afk', pinnedRef: false }, 'main')).toBe(false);
  });

  it('returns false when ref is null (legacy: no ref at all)', () => {
    expect(isPinnedRef({ ref: null, pinnedRef: undefined }, 'main')).toBe(false);
  });

  it('returns false when ref matches the default branch (legacy: auto-picked branch)', () => {
    expect(isPinnedRef({ ref: 'main', pinnedRef: undefined }, 'main')).toBe(false);
  });

  it('returns false when ref is a semver tag (legacy: auto-picked tag)', () => {
    expect(isPinnedRef({ ref: 'v2.0.0', pinnedRef: undefined }, 'main')).toBe(false);
    expect(isPinnedRef({ ref: '1.2.3', pinnedRef: undefined }, 'main')).toBe(false);
  });

  it('returns true when ref is a non-semver, non-default value (legacy migration: --ref branch)', () => {
    expect(isPinnedRef({ ref: 'afk', pinnedRef: undefined }, 'main')).toBe(true);
    expect(isPinnedRef({ ref: 'feature/foo', pinnedRef: undefined }, 'main')).toBe(true);
    expect(isPinnedRef({ ref: 'abc1234', pinnedRef: undefined }, 'main')).toBe(true);
  });
});

describe('isMarketplacePinnedRef', () => {
  it('mirrors isPinnedRef semantics for marketplace entries', () => {
    expect(isMarketplacePinnedRef({ ref: 'afk', pinnedRef: true }, 'main')).toBe(true);
    expect(isMarketplacePinnedRef({ ref: 'v2.0.0', pinnedRef: undefined }, 'main')).toBe(false);
    expect(isMarketplacePinnedRef({ ref: 'afk', pinnedRef: undefined }, 'main')).toBe(true);
    expect(isMarketplacePinnedRef({ ref: 'main', pinnedRef: undefined }, 'main')).toBe(false);
  });
});

describe('upsertPlugin — pinnedRef round-trip', () => {
  it('persists pinnedRef: true through upsert/read cycle', () => {
    const entry = sampleEntry({ pinnedRef: true });
    upsertPlugin('pinned', entry, indexPath);
    expect(readIndex(indexPath).plugins['pinned'].pinnedRef).toBe(true);
  });

  it('persists pinnedRef: false through upsert/read cycle', () => {
    const entry = sampleEntry({ pinnedRef: false });
    upsertPlugin('unpinned', entry, indexPath);
    expect(readIndex(indexPath).plugins['unpinned'].pinnedRef).toBe(false);
  });

  it('preserves absence of pinnedRef for legacy entries (no field = undefined)', () => {
    const { pinnedRef: _p, ...legacyEntry } = sampleEntry({ pinnedRef: false });
    upsertPlugin('legacy', legacyEntry as any, indexPath);
    const stored = readIndex(indexPath).plugins['legacy'];
    expect(stored.pinnedRef).toBeUndefined();
  });
});

describe('upsertMarketplace — pinnedRef round-trip', () => {
  it('persists pinnedRef: true for marketplace entries', () => {
    const entry = sampleMarketplace({ pinnedRef: true });
    upsertMarketplace('pinned-mp', entry, indexPath);
    expect(readIndex(indexPath).marketplaces['pinned-mp'].pinnedRef).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setPluginOption / unsetPluginOption
// ---------------------------------------------------------------------------

import { setPluginOption, unsetPluginOption } from './index-store.js';

describe('setPluginOption', () => {
  it('stores an option on an existing plugin entry', () => {
    upsertPlugin('myplugin', sampleEntry(), indexPath);
    setPluginOption('myplugin', 'provider', 'openai', indexPath);
    const stored = readIndex(indexPath).plugins['myplugin']?.options;
    expect(stored).toEqual({ provider: 'openai' });
  });

  it('merges with existing options without overwriting others', () => {
    upsertPlugin('myplugin', sampleEntry({ options: { region: 'us' } }), indexPath);
    setPluginOption('myplugin', 'provider', 'openai', indexPath);
    const stored = readIndex(indexPath).plugins['myplugin']?.options;
    expect(stored).toEqual({ region: 'us', provider: 'openai' });
  });

  it('throws when plugin is not in the index', () => {
    expect(() => setPluginOption('missing', 'key', 'val', indexPath)).toThrow(/"missing"/);
  });
});

describe('unsetPluginOption', () => {
  it('removes a stored option key', () => {
    upsertPlugin('myplugin', sampleEntry({ options: { provider: 'openai', region: 'us' } }), indexPath);
    unsetPluginOption('myplugin', 'provider', indexPath);
    const stored = readIndex(indexPath).plugins['myplugin']?.options;
    expect(stored).toEqual({ region: 'us' });
  });

  it('sets options to undefined when last key is removed', () => {
    upsertPlugin('myplugin', sampleEntry({ options: { provider: 'openai' } }), indexPath);
    unsetPluginOption('myplugin', 'provider', indexPath);
    expect(readIndex(indexPath).plugins['myplugin']?.options).toBeUndefined();
  });

  it('is a no-op when the key is absent', () => {
    upsertPlugin('myplugin', sampleEntry({ options: { region: 'us' } }), indexPath);
    unsetPluginOption('myplugin', 'missing', indexPath);
    expect(readIndex(indexPath).plugins['myplugin']?.options).toEqual({ region: 'us' });
  });

  it('throws when plugin is not in the index', () => {
    expect(() => unsetPluginOption('missing', 'key', indexPath)).toThrow(/"missing"/);
  });
});
