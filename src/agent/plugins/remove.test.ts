/**
 * Tests for the plugin remover.
 */

// [F2/S8] Hoist the scan-cache mock so remove.ts picks it up at module load.
const resetScanCache = vi.hoisted(() => vi.fn());
vi.mock('../plugins-scanner.js', () => ({ _resetPluginScanCache: resetScanCache, scanLocalPlugins: vi.fn(() => []) }));

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { removePlugin } from './remove.js';
import { readIndex, upsertPlugin } from './index-store.js';

let tmpDir: string;
let pluginsDir: string;
let indexPath: string;
let sourceDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-remove-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  pluginsDir = join(tmpDir, 'plugins');
  indexPath = join(pluginsDir, '.index.json');
  sourceDir = join(tmpDir, 'src');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  resetScanCache.mockClear();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('removePlugin', () => {
  it('removes a directory and its index entry', () => {
    const dir = join(pluginsDir, 'nuke-me');
    mkdirSync(dir);
    writeFileSync(join(dir, 'file.txt'), 'hi');
    upsertPlugin(
      'nuke-me',
      {
        source: 'x', sourceType: 'local', ref: null, commit: null,
        enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
      indexPath,
    );

    const result = removePlugin('nuke-me', { pluginsDir, indexPath });
    expect(result).toEqual({ name: 'nuke-me', removedDir: true, removedIndexEntry: true });
    expect(existsSync(dir)).toBe(false);
    expect(readIndex(indexPath).plugins['nuke-me']).toBeUndefined();
  });

  it('unlinks a symlink without touching the target', () => {
    const link = join(pluginsDir, 'linked');
    symlinkSync(sourceDir, link, 'dir');

    const result = removePlugin('linked', { pluginsDir, indexPath });
    expect(result.removedDir).toBe(true);
    expect(existsSync(link)).toBe(false);
    // Source survives.
    expect(existsSync(sourceDir)).toBe(true);
  });

  it('is a no-op when neither dir nor index entry exists', () => {
    const result = removePlugin('ghost', { pluginsDir, indexPath });
    expect(result).toEqual({ name: 'ghost', removedDir: false, removedIndexEntry: false });
  });

  it('removes a stray index entry even when the dir is gone', () => {
    upsertPlugin(
      'orphan',
      {
        source: 'x', sourceType: 'local', ref: null, commit: null,
        enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
      indexPath,
    );
    const result = removePlugin('orphan', { pluginsDir, indexPath });
    expect(result).toEqual({ name: 'orphan', removedDir: false, removedIndexEntry: true });
    expect(readIndex(indexPath).plugins['orphan']).toBeUndefined();
  });
});

// ── F2: scan-cache invalidation ─────────────────────────────────────────────

describe('removePlugin — cache invalidation (F2)', () => {
  it('calls _resetPluginScanCache when a directory is removed', () => {
    const dir = join(pluginsDir, 'evict-me');
    mkdirSync(dir);
    writeFileSync(join(dir, 'file.txt'), 'hi');
    upsertPlugin(
      'evict-me',
      {
        source: 'x', sourceType: 'local', ref: null, commit: null,
        enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
      indexPath,
    );
    removePlugin('evict-me', { pluginsDir, indexPath });
    expect(resetScanCache).toHaveBeenCalledOnce();
  });

  it('calls _resetPluginScanCache even when only the index entry existed (no dir)', () => {
    upsertPlugin(
      'index-only',
      {
        source: 'x', sourceType: 'local', ref: null, commit: null,
        enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      },
      indexPath,
    );
    removePlugin('index-only', { pluginsDir, indexPath });
    expect(resetScanCache).toHaveBeenCalledOnce();
  });

  it('calls _resetPluginScanCache when removing a symlinked plugin', () => {
    const link = join(pluginsDir, 'linked-evict');
    symlinkSync(sourceDir, link, 'dir');
    removePlugin('linked-evict', { pluginsDir, indexPath });
    expect(resetScanCache).toHaveBeenCalledOnce();
  });

  it('calls _resetPluginScanCache even when plugin does not exist (idempotent no-op)', () => {
    removePlugin('ghost-plugin', { pluginsDir, indexPath });
    expect(resetScanCache).toHaveBeenCalledOnce();
  });
});

// ── S8: name validation ──────────────────────────────────────────────────────

describe('removePlugin — name validation (S8)', () => {
  it('throws for path-traversal name "../evil"', () => {
    expect(() => removePlugin('../evil', { pluginsDir, indexPath })).toThrow(
      /Invalid plugin name/,
    );
  });

  it('throws for path-traversal name ".."', () => {
    expect(() => removePlugin('..', { pluginsDir, indexPath })).toThrow(
      /Invalid plugin name/,
    );
  });

  it('throws for absolute-path name "/absolute/path"', () => {
    expect(() => removePlugin('/absolute/path', { pluginsDir, indexPath })).toThrow(
      /Invalid plugin name/,
    );
  });

  it('throws for name with a slash "foo/bar"', () => {
    expect(() => removePlugin('foo/bar', { pluginsDir, indexPath })).toThrow(
      /Invalid plugin name/,
    );
  });

  it('does NOT throw for a valid name', () => {
    expect(() => removePlugin('valid-plugin', { pluginsDir, indexPath })).not.toThrow();
  });
});
