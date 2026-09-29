/**
 * Tests for repo-manifest.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRepoManifest, formatRepoManifest, pathExistsInCwd } from './repo-manifest.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpGitRepo(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatif-manifest-'));

  // Init git repo
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });

  // Create and add files
  for (const f of files) {
    const full = path.join(dir, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], { cwd: dir, stdio: 'ignore' });

  return dir;
}

// ---------------------------------------------------------------------------
// buildRepoManifest
// ---------------------------------------------------------------------------

describe('buildRepoManifest', () => {
  it('returns empty manifest outside a git repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatif-nogit-'));
    const manifest = await buildRepoManifest(dir);
    expect(manifest.languages).toEqual([]);
    expect(manifest.paths).toEqual([]);
    expect(manifest.allPaths.size).toBe(0);
  });

  it('detects TypeScript and Markdown as primary languages', async () => {
    const dir = makeTmpGitRepo([
      'src/index.ts',
      'src/foo.ts',
      'src/bar.tsx',
      'README.md',
      'docs/guide.md',
    ]);
    const manifest = await buildRepoManifest(dir);
    expect(manifest.languages).toContain('TypeScript');
    expect(manifest.languages).toContain('Markdown');
  });

  it('includes tracked paths in allPaths', async () => {
    const dir = makeTmpGitRepo(['src/index.ts', 'package.json', 'README.md']);
    const manifest = await buildRepoManifest(dir);
    expect(manifest.allPaths.has('src/index.ts')).toBe(true);
    expect(manifest.allPaths.has('package.json')).toBe(true);
    expect(manifest.allPaths.has('README.md')).toBe(true);
  });

  it('does NOT include non-existent paths in allPaths', async () => {
    const dir = makeTmpGitRepo(['src/index.ts']);
    const manifest = await buildRepoManifest(dir);
    expect(manifest.allPaths.has('src/main.py')).toBe(false);
    expect(manifest.allPaths.has('config.yaml')).toBe(false);
  });

  it('caps paths sample at MAX_SAMPLE_PATHS entries', async () => {
    // Create 60 tracked .ts files
    const files = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`);
    const dir = makeTmpGitRepo(files);
    const manifest = await buildRepoManifest(dir);
    expect(manifest.paths.length).toBeLessThanOrEqual(50);
    // allPaths still has all 60
    expect(manifest.allPaths.size).toBe(60);
  });

  // finding #2 (advisory review #2455): unexpected git failures (not "not a
  // git repo") must emit a console.warn, so silent grounding loss is visible.
  describe('warning on unexpected failure', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('does not warn for a non-git directory (expected fail-open)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatif-nogit-warn-'));
      await buildRepoManifest(dir);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// formatRepoManifest
// ---------------------------------------------------------------------------

describe('formatRepoManifest', () => {
  it('returns empty string for an empty manifest', () => {
    const manifest = { languages: [], paths: [], allPaths: new Set<string>() };
    expect(formatRepoManifest(manifest)).toBe('');
  });

  it('includes repo context header', () => {
    const manifest = {
      languages: ['TypeScript'],
      paths: ['src/index.ts', 'README.md'],
      allPaths: new Set(['src/index.ts', 'README.md']),
    };
    const text = formatRepoManifest(manifest);
    expect(text).toContain('## Repo context');
    expect(text).toContain('TypeScript');
    expect(text).toContain('src/index.ts');
    expect(text).toContain('README.md');
  });

  it('includes IMPORTANT grounding instruction', () => {
    const manifest = {
      languages: ['TypeScript'],
      paths: ['src/index.ts'],
      allPaths: new Set(['src/index.ts']),
    };
    const text = formatRepoManifest(manifest);
    expect(text).toContain('IMPORTANT');
    expect(text).toContain('probes MUST reference only paths');
  });

  // finding #5 (advisory review #2455): the grounding clause must be present
  // when a manifest is returned, and absent (empty string) when none.
  it('grounding clause is present when manifest has data', () => {
    const manifest = {
      languages: ['TypeScript'],
      paths: ['src/index.ts'],
      allPaths: new Set(['src/index.ts']),
    };
    const text = formatRepoManifest(manifest);
    expect(text).toContain('Never invent file names');
  });

  it('grounding clause is absent (empty string) when manifest is empty', () => {
    const manifest = { languages: [], paths: [], allPaths: new Set<string>() };
    const text = formatRepoManifest(manifest);
    expect(text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// pathExistsInCwd
// ---------------------------------------------------------------------------

describe('pathExistsInCwd', () => {
  it('returns true for an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatif-pe-'));
    fs.writeFileSync(path.join(dir, 'myfile.ts'), '');
    expect(pathExistsInCwd(dir, 'myfile.ts')).toBe(true);
  });

  it('returns false for a non-existent file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatif-pe2-'));
    expect(pathExistsInCwd(dir, 'nonexistent.py')).toBe(false);
  });
});
