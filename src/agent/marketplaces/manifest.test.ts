/**
 * Tests for the marketplace.json parser. Validates required fields,
 * optional metadata/owner blocks, object-valued source entries, and
 * rejection of malformed shapes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  isMarketplaceDir,
  isGitSubdirSource,
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
    const tmpFoo = resolve('/tmp/foo');
    expect(manifestPath(tmpFoo)).toBe(join(tmpFoo, '.claude-plugin', 'marketplace.json'));
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

  it('trims whitespace from name and string source', () => {
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

describe('readManifest — object source: git-subdir', () => {
  it('accepts a well-formed git-subdir source', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        {
          name: 'api-sec',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/anthropics/claude-plugins-official',
            path: 'plugins/api-security-testing',
            ref: 'main',
            sha: 'abc1234',
          },
          description: 'API security testing plugin',
        },
      ],
    });
    const manifest = readManifest(tmpDir);
    expect(manifest.plugins).toHaveLength(1);
    const p = manifest.plugins[0]!;
    expect(p.name).toBe('api-sec');
    expect(p.description).toBe('API security testing plugin');
    expect(p.skipped).toBeUndefined();
    expect(isGitSubdirSource(p.source)).toBe(true);
    if (isGitSubdirSource(p.source)) {
      expect(p.source.url).toBe('https://github.com/anthropics/claude-plugins-official');
      expect(p.source.path).toBe('plugins/api-security-testing');
      expect(p.source.ref).toBe('main');
      expect(p.source.sha).toBe('abc1234');
    }
  });

  it('accepts git-subdir without optional ref and sha', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        {
          name: 'myplugin',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/example/repo',
            path: 'plugins/myplugin',
          },
        },
      ],
    });
    const manifest = readManifest(tmpDir);
    const p = manifest.plugins[0]!;
    expect(isGitSubdirSource(p.source)).toBe(true);
    if (isGitSubdirSource(p.source)) {
      expect(p.source.ref).toBeUndefined();
      expect(p.source.sha).toBeUndefined();
    }
    expect(p.skipped).toBeUndefined();
  });

  it('marks a git-subdir entry skipped when url is missing', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        {
          name: 'bad',
          source: { source: 'git-subdir', path: 'plugins/bad' },
        },
      ],
    });
    const manifest = readManifest(tmpDir);
    const p = manifest.plugins[0]!;
    expect(p.skipped).toMatch(/missing required "url"/);
  });

  it('marks a git-subdir entry skipped when path is missing', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        {
          name: 'bad',
          source: { source: 'git-subdir', url: 'https://github.com/example/repo' },
        },
      ],
    });
    const manifest = readManifest(tmpDir);
    const p = manifest.plugins[0]!;
    expect(p.skipped).toMatch(/missing required "path"/);
  });

  it('does NOT throw for the whole manifest when one entry has a malformed git-subdir source', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        { name: 'good', source: './plugins/good' },
        { name: 'bad', source: { source: 'git-subdir', path: 'plugins/bad' } }, // missing url
        {
          name: 'also-good',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/example/repo',
            path: 'plugins/also-good',
          },
        },
      ],
    });
    const manifest = readManifest(tmpDir);
    expect(manifest.plugins).toHaveLength(3);
    expect(manifest.plugins[0]!.source).toBe('./plugins/good');
    expect(manifest.plugins[1]!.skipped).toBeTruthy();
    expect(manifest.plugins[2]!.skipped).toBeUndefined();
    expect(isGitSubdirSource(manifest.plugins[2]!.source)).toBe(true);
  });
});

describe('readManifest — object source: unknown discriminator', () => {
  it('marks entries with unknown source discriminator as skipped', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        {
          name: 'future-plugin',
          source: { source: 'some-future-type', location: 'somewhere' },
        },
      ],
    });
    const manifest = readManifest(tmpDir);
    const p = manifest.plugins[0]!;
    expect(p.skipped).toMatch(/unsupported source type "some-future-type"/);
  });

  it('marks entries with no source discriminator as skipped', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        {
          name: 'weird',
          source: { url: 'https://example.com' }, // no `source` field
        },
      ],
    });
    const manifest = readManifest(tmpDir);
    const p = manifest.plugins[0]!;
    expect(p.skipped).toMatch(/unsupported source type/);
  });

  it('does NOT throw for the whole manifest when one entry has an unknown object source', () => {
    writeManifestRaw(tmpDir, {
      name: 'mp',
      plugins: [
        { name: 'a', source: './plugins/a' },
        { name: 'b', source: { source: 'unknown-type', extra: 'data' } },
        { name: 'c', source: 'https://github.com/owner/repo' },
      ],
    });
    const manifest = readManifest(tmpDir);
    expect(manifest.plugins).toHaveLength(3);
    expect(manifest.plugins[0]!.skipped).toBeUndefined();
    expect(manifest.plugins[1]!.skipped).toBeTruthy();
    expect(manifest.plugins[2]!.skipped).toBeUndefined();
  });

  it('simulates the anthropics/claude-plugins-official manifest shape (262 object + 53 string)', () => {
    // Build a synthetic manifest matching the live one's shape.
    const objectPlugins = Array.from({ length: 262 }, (_, i) => ({
      name: `obj-plugin-${i}`,
      source: {
        source: 'git-subdir',
        url: 'https://github.com/anthropics/claude-plugins-official',
        path: `plugins/obj-plugin-${i}`,
        ref: 'main',
        sha: `sha${i}`,
      },
    }));
    const stringPlugins = Array.from({ length: 53 }, (_, i) => ({
      name: `str-plugin-${i}`,
      source: `./plugins/str-plugin-${i}`,
    }));
    writeManifestRaw(tmpDir, {
      name: 'claude-plugins-official',
      plugins: [...objectPlugins, ...stringPlugins],
    });

    const manifest = readManifest(tmpDir);
    expect(manifest.plugins).toHaveLength(315);
    const skipped = manifest.plugins.filter((p) => p.skipped);
    expect(skipped).toHaveLength(0);
    const gitSubdirs = manifest.plugins.filter((p) => isGitSubdirSource(p.source));
    expect(gitSubdirs).toHaveLength(262);
    const strings = manifest.plugins.filter((p) => typeof p.source === 'string');
    expect(strings).toHaveLength(53);
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

  it('throws when a plugin entry is missing name', () => {
    writeManifestRaw(tmpDir, { name: 'mp', plugins: [{ source: './plugins/p1' }] });
    expect(() => readManifest(tmpDir)).toThrow(/missing required "name"/);
  });

  it('throws when a plugin entry has a null/missing source', () => {
    writeManifestRaw(tmpDir, { name: 'mp', plugins: [{ name: 'p1' }] });
    expect(() => readManifest(tmpDir)).toThrow(/missing required "source"/);
  });

  it('throws when a plugin entry has an empty-string source', () => {
    writeManifestRaw(tmpDir, { name: 'mp', plugins: [{ name: 'p1', source: '   ' }] });
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

describe('isGitSubdirSource', () => {
  it('returns true for a GitSubdirSource object', () => {
    expect(isGitSubdirSource({ source: 'git-subdir', url: 'https://x.com', path: 'p' })).toBe(true);
  });

  it('returns false for a string', () => {
    expect(isGitSubdirSource('./path')).toBe(false);
  });

  it('returns false for an object with a different discriminator', () => {
    expect(isGitSubdirSource({ source: 'other', url: 'https://x.com', path: 'p' })).toBe(false);
  });
});
