/**
 * Tests for the marketplace.json parser. Validates required fields,
 * optional metadata/owner blocks, and rejection of malformed shapes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isMarketplaceDir,
  manifestPath,
  readManifest,
  tryReadManifest,
} from './manifest.js';

let tmpDir: string;

function writeManifestRaw(dir: string, payload: unknown): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    typeof payload === 'string' ? payload : JSON.stringify(payload),
  );
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-mfest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('manifestPath / isMarketplaceDir', () => {
  it('points at .claude-plugin/marketplace.json under the dir', () => {
    expect(manifestPath('/tmp/foo')).toBe('/tmp/foo/.claude-plugin/marketplace.json');
  });

  it('reports false when the manifest is missing', () => {
    expect(isMarketplaceDir(tmpDir)).toBe(false);
  });

  it('reports true when the manifest is present', () => {
    writeManifestRaw(tmpDir, { name: 'mp', plugins: [] });
    expect(isMarketplaceDir(tmpDir)).toBe(true);
  });
});

describe('readManifest — happy path', () => {
  it('parses a minimal manifest', () => {
    writeManifestRaw(tmpDir, { name: 'mp', plugins: [] });
    expect(readManifest(tmpDir)).toEqual({ name: 'mp', plugins: [] });
  });

  it('parses metadata and owner', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      metadata: { description: 'a marketplace' },
      owner: { name: 'Griffin', email: 'g@example.com' },
      plugins: [{ name: 'p1', source: './plugins/p1', description: 'first' }],
    });
    expect(readManifest(tmpDir)).toEqual({
      name: 'mp',
      metadata: { description: 'a marketplace' },
      owner: { name: 'Griffin', email: 'g@example.com' },
      plugins: [{ name: 'p1', source: './plugins/p1', description: 'first' }],
    });
  });

  it('omits empty metadata and owner blocks', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      metadata: { other: 'ignored' },
      owner: { other: 'ignored' },
      plugins: [],
    });
    const parsed = readManifest(tmpDir);
    expect(parsed.metadata).toBeUndefined();
    expect(parsed.owner).toBeUndefined();
  });

  it('trims whitespace from name and source', () => {
    writeManifestRaw(tmpDir, {
      name: '  mp  ',
      plugins: [{ name: '  p1  ', source: '  ./plugins/p1  ' }],
    });
    expect(readManifest(tmpDir)).toEqual({
      name: 'mp',
      plugins: [{ name: 'p1', source: './plugins/p1' }],
    });
  });
});

describe('readManifest — rejection cases', () => {
  it('throws when the manifest is missing', () => {
    expect(() => readManifest(tmpDir)).toThrow(/marketplace manifest not found/);
  });

  it('throws on invalid JSON', () => {
    writeManifestRaw(tmpDir, 'not json at all');
    expect(() => readManifest(tmpDir)).toThrow(/not valid JSON/);
  });

  it('throws when the manifest is not an object', () => {
    writeManifestRaw(tmpDir, '"a string"');
    expect(() => readManifest(tmpDir)).toThrow(/must be a JSON object/);
  });

  it('throws when name is missing', () => {
    writeManifestRaw(tmpDir, { plugins: [] });
    expect(() => readManifest(tmpDir)).toThrow(/missing required "name"/);
  });

  it('throws when plugins is not an array', () => {
    writeManifestRaw(tmpDir, { name: 'mp', plugins: { foo: 'bar' } });
    expect(() => readManifest(tmpDir)).toThrow(/missing required "plugins" array/);
  });

  it('throws when a plugin entry is missing name or source', () => {
    writeManifestRaw(tmpDir, { name: 'mp', plugins: [{ source: './plugins/p1' }] });
    expect(() => readManifest(tmpDir)).toThrow(/missing required "name"/);

    writeManifestRaw(tmpDir, { name: 'mp', plugins: [{ name: 'p1' }] });
    expect(() => readManifest(tmpDir)).toThrow(/missing required "source"/);
  });

  it('throws on duplicate plugin names', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        { name: 'p1', source: './a' },
        { name: 'p1', source: './b' },
      ],
    });
    expect(() => readManifest(tmpDir)).toThrow(/duplicate plugin name/);
  });
});

describe('tryReadManifest', () => {
  it('returns null instead of throwing on a bad manifest', () => {
    writeManifestRaw(tmpDir, 'broken');
    expect(tryReadManifest(tmpDir)).toBeNull();
  });

  it('returns null when the manifest is missing', () => {
    expect(tryReadManifest(tmpDir)).toBeNull();
  });

  it('returns the parsed manifest on success', () => {
    writeManifestRaw(tmpDir, { name: 'mp', plugins: [] });
    expect(tryReadManifest(tmpDir)).toEqual({ name: 'mp', plugins: [] });
  });
});
