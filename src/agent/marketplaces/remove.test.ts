/**
 * Tests for marketplace removal. Covers cache-dir cleanup, index entry
 * removal, and cascade of `<mp>:<plugin>` entries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeMarketplace } from './remove.js';
import {
  readIndex,
  upsertMarketplace,
  upsertPlugin,
} from '../plugins/index-store.js';

let tmpDir: string;
let cacheDir: string;
let indexPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-mp-rm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cacheDir = join(tmpDir, 'cache');
  indexPath = join(tmpDir, '.index.json');
  mkdirSync(cacheDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedIndex(): void {
  upsertMarketplace(
    'mp1',
    {
      source: 'x',
      sourceType: 'local',
      ref: null,
      commit: null,
      installedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    indexPath,
  );
  upsertPlugin(
    'mp1:foo',
    {
      source: 'mp1:foo',
      sourceType: 'marketplace',
      ref: null,
      commit: null,
      enabled: true,
      installedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      marketplace: 'mp1',
    },
    indexPath,
  );
  upsertPlugin(
    'standalone',
    {
      source: 'anthropics/standalone',
      sourceType: 'github',
      ref: null,
      commit: null,
      enabled: true,
      installedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    indexPath,
  );
}

describe('removeMarketplace', () => {
  it('removes a real cache directory and the index entry', () => {
    const mpDir = join(cacheDir, 'mp1');
    mkdirSync(mpDir, { recursive: true });
    writeFileSync(join(mpDir, 'sentinel'), 'x');
    seedIndex();

    const result = removeMarketplace('mp1', { cacheDir, indexPath });

    expect(result.removedDir).toBe(true);
    expect(result.removedIndexEntry).toBe(true);
    expect(result.removedPluginEntries).toEqual(['mp1:foo']);
    expect(existsSync(mpDir)).toBe(false);

    const idx = readIndex(indexPath);
    expect(idx.marketplaces.mp1).toBeUndefined();
    expect(idx.plugins['mp1:foo']).toBeUndefined();
    expect(idx.plugins.standalone).toBeDefined();
  });

  it('removes a symlinked cache entry', () => {
    const mpDir = join(cacheDir, 'mp1');
    const realSource = join(tmpDir, 'real-source');
    mkdirSync(realSource, { recursive: true });
    symlinkSync(realSource, mpDir, 'dir');
    seedIndex();

    const result = removeMarketplace('mp1', { cacheDir, indexPath });
    expect(result.removedDir).toBe(true);
    expect(existsSync(mpDir)).toBe(false);
    expect(existsSync(realSource)).toBe(true);
  });

  it('is a no-op when nothing is installed under the name', () => {
    const result = removeMarketplace('ghost', { cacheDir, indexPath });
    expect(result.removedDir).toBe(false);
    expect(result.removedIndexEntry).toBe(false);
    expect(result.removedPluginEntries).toEqual([]);
  });

  it('still cascades plugin entries when the cache dir was already gone', () => {
    seedIndex();
    // Don't create the dir — simulate stale index after manual removal.

    const result = removeMarketplace('mp1', { cacheDir, indexPath });
    expect(result.removedDir).toBe(false);
    expect(result.removedIndexEntry).toBe(true);
    expect(result.removedPluginEntries).toEqual(['mp1:foo']);
  });
});
