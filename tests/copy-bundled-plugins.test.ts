import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(testDir, '..', 'scripts');

// Dynamic import of the build-script helper — mirrors tests/postinstall.test.ts,
// which does `await import('../scripts/postinstall.mjs')`. scripts/ is outside
// tsconfig's `include`, so this stays untyped-JS interop, which is fine here.
type CopyResult = { copied: boolean; fileCount: number; src: string; dest: string };
let copyBundledPlugins: (srcRoot: string, distRoot: string) => CopyResult;

beforeAll(async () => {
  ({ copyBundledPlugins } = await import('../scripts/lib/copy-bundled-plugins.mjs'));
});

describe('copyBundledPlugins', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-bundled-test-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('recursively copies the bundled-plugins tree into distRoot, including non-.md files', () => {
    const srcRoot = join(tmp, 'src');
    const distRoot = join(tmp, 'dist');

    const pluginMetaDir = join(srcRoot, 'bundled-plugins', 'awa-bundled', '.claude-plugin');
    const skillDir = join(srcRoot, 'bundled-plugins', 'awa-bundled', 'skills', 'demo');
    mkdirSync(pluginMetaDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(pluginMetaDir, 'plugin.json'), '{"name":"awa-bundled"}');
    writeFileSync(join(skillDir, 'SKILL.md'), '# demo skill');

    const result = copyBundledPlugins(srcRoot, distRoot);

    expect(result.copied).toBe(true);
    expect(result.fileCount).toBe(2);

    // The SKILL.md content round-trips.
    expect(
      readFileSync(
        join(distRoot, 'bundled-plugins', 'awa-bundled', 'skills', 'demo', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# demo skill');

    // Non-.md files (plugin.json) must be copied too. This is precisely the part
    // a generic `*.md`-only walk misses — and the part build-dist.mjs omitted
    // entirely before this fix, leaving the published tarball without bundled skills.
    expect(
      existsSync(join(distRoot, 'bundled-plugins', 'awa-bundled', '.claude-plugin', 'plugin.json')),
    ).toBe(true);
  });

  it('is a no-op when the source tree is absent (never throws)', () => {
    const result = copyBundledPlugins(join(tmp, 'nonexistent-src'), join(tmp, 'dist'));
    expect(result.copied).toBe(false);
    expect(result.fileCount).toBe(0);
    expect(existsSync(join(tmp, 'dist', 'bundled-plugins'))).toBe(false);
  });
});

describe('both build scripts route bundled-plugins through the shared helper', () => {
  // Wiring guard: the regression we are fixing was a SECOND, divergent copy
  // implementation. If a future edit re-introduces an inline copy (or drops the
  // helper call) in either build path, this fails — keeping the two paths unified.
  for (const script of ['build-dist.mjs', 'copy-prompts.js']) {
    it(`${script} imports and calls copyBundledPlugins`, () => {
      const source = readFileSync(join(scriptsDir, script), 'utf8');
      expect(source).toContain('copy-bundled-plugins.mjs');
      expect(source).toMatch(/copyBundledPlugins\s*\(/);
    });
  }
});
