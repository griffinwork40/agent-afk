/**
 * Tests for src/browser/witness.ts
 *
 * Covers:
 *   - Directory tree creation on first call
 *   - Concurrent screenshot writes do not collide
 *   - Returned path is inside screenshotsDir(sessionId)
 *   - Returned bytes matches actual file size on disk
 *   - DOM snapshot is valid gzip (round-trip via zlib.gunzip)
 *   - Screenshot filename matches the required pattern
 */

import { gunzip } from 'zlib';
import { promisify } from 'util';
import { mkdtempSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  browserSidecarDir,
  domSnapshotsDir,
  screenshotsDir,
  writeDomSnapshotSidecar,
  writeScreenshotSidecar,
} from './witness.js';

const gunzipAsync = promisify(gunzip);

// ---------------------------------------------------------------------------
// Test scaffolding
//
// We redirect AFK_HOME to a per-test tmpdir so getTraceDir() resolves to a
// path that is isolated and writable, without touching ~/.afk.
// ---------------------------------------------------------------------------

let originalAFKHome: string | undefined;
let tmpHome: string;
const TEST_SESSION_ID = 'test-session-witness-01';

beforeEach(() => {
  originalAFKHome = process.env['AFK_HOME'];
  tmpHome = mkdtempSync(join(tmpdir(), 'afk-witness-test-'));
  process.env['AFK_HOME'] = tmpHome;
});

afterEach(() => {
  if (originalAFKHome === undefined) {
    delete process.env['AFK_HOME'];
  } else {
    process.env['AFK_HOME'] = originalAFKHome;
  }
});

// ---------------------------------------------------------------------------
// browserSidecarDir / screenshotsDir / domSnapshotsDir — pure path helpers
// ---------------------------------------------------------------------------

describe('directory path helpers', () => {
  it('browserSidecarDir nests under the witness trace dir', () => {
    const dir = browserSidecarDir(TEST_SESSION_ID);
    expect(dir).toContain(TEST_SESSION_ID);
    expect(dir).toContain('browser');
    expect(dir).toContain('witness');
  });

  it('screenshotsDir is a subdir of browserSidecarDir', () => {
    expect(screenshotsDir(TEST_SESSION_ID)).toBe(
      join(browserSidecarDir(TEST_SESSION_ID), 'screenshots'),
    );
  });

  it('domSnapshotsDir is a subdir of browserSidecarDir', () => {
    expect(domSnapshotsDir(TEST_SESSION_ID)).toBe(
      join(browserSidecarDir(TEST_SESSION_ID), 'dom-snapshots'),
    );
  });
});

// ---------------------------------------------------------------------------
// writeScreenshotSidecar
// ---------------------------------------------------------------------------

describe('writeScreenshotSidecar', () => {
  it('creates the screenshots directory tree on first call', async () => {
    const buf = Buffer.from('fake-png-data');
    const result = await writeScreenshotSidecar(TEST_SESSION_ID, buf, 'browser_screenshot');

    // The returned path must exist.
    const s = await stat(result.path);
    expect(s.isFile()).toBe(true);

    // The screenshots/ dir must now exist.
    const dir = screenshotsDir(TEST_SESSION_ID);
    const entries = await readdir(dir);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('returned path is inside screenshotsDir(sessionId)', async () => {
    const buf = Buffer.from('png-content');
    const result = await writeScreenshotSidecar(TEST_SESSION_ID, buf, 'browser_open');
    expect(result.path.startsWith(screenshotsDir(TEST_SESSION_ID))).toBe(true);
  });

  it('returned bytes matches actual file size on disk', async () => {
    const buf = Buffer.from('abcdefghij'); // 10 bytes
    const result = await writeScreenshotSidecar(TEST_SESSION_ID, buf, 'browser_act');
    const s = await stat(result.path);
    expect(result.bytes).toBe(s.size);
    expect(result.bytes).toBe(10);
  });

  it('concurrent writes do not collide — 10 parallel writes produce 10 distinct files', async () => {
    const N = 10;
    const buf = Buffer.from('screenshot-payload');

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        writeScreenshotSidecar(TEST_SESSION_ID, buf, 'browser_observe'),
      ),
    );

    const paths = results.map((r) => r.path);
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(N);

    // All files must actually exist on disk.
    for (const p of paths) {
      const s = await stat(p);
      expect(s.isFile()).toBe(true);
    }
  });

  it('filename matches the required pattern for each tool variant', async () => {
    // Pattern: <isoTs-fs-safe>-<random6>-<tool>.png
    // The isoTs-fs-safe portion is a sequence of digits, 'T', 'Z', and '-'.
    const PATTERN =
      /^[0-9TZ-]+-[0-9a-f]{6}-browser_(open|observe|act|screenshot|extract)\.png$/;

    const tools = [
      'browser_open',
      'browser_observe',
      'browser_act',
      'browser_screenshot',
      'browser_extract',
    ] as const;

    for (const tool of tools) {
      const result = await writeScreenshotSidecar(
        TEST_SESSION_ID,
        Buffer.from('x'),
        tool,
      );
      const basename = result.path.split('/').at(-1) ?? '';
      expect(basename).toMatch(PATTERN);
    }
  });

  it('works when called a second time without creating the dir again (idempotent mkdir)', async () => {
    const buf = Buffer.from('data');
    const r1 = await writeScreenshotSidecar(TEST_SESSION_ID, buf, 'browser_screenshot');
    const r2 = await writeScreenshotSidecar(TEST_SESSION_ID, buf, 'browser_screenshot');
    expect(r1.path).not.toBe(r2.path);
    const s1 = await stat(r1.path);
    const s2 = await stat(r2.path);
    expect(s1.isFile()).toBe(true);
    expect(s2.isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeDomSnapshotSidecar
// ---------------------------------------------------------------------------

describe('writeDomSnapshotSidecar', () => {
  it('creates the dom-snapshots directory tree on first call', async () => {
    const result = await writeDomSnapshotSidecar(TEST_SESSION_ID, '<html><body>hi</body></html>');
    const s = await stat(result.path);
    expect(s.isFile()).toBe(true);

    const dir = domSnapshotsDir(TEST_SESSION_ID);
    const entries = await readdir(dir);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('returned path is inside domSnapshotsDir(sessionId)', async () => {
    const result = await writeDomSnapshotSidecar(TEST_SESSION_ID, '<html/>');
    expect(result.path.startsWith(domSnapshotsDir(TEST_SESSION_ID))).toBe(true);
  });

  it('returned bytes matches actual compressed file size on disk', async () => {
    const html = '<html><body>hello world</body></html>';
    const result = await writeDomSnapshotSidecar(TEST_SESSION_ID, html);
    const s = await stat(result.path);
    expect(result.bytes).toBe(s.size);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('file is valid gzip — round-trip decompresses to original HTML', async () => {
    const html = '<html><body><h1>Test</h1><p>Content here</p></body></html>';
    const result = await writeDomSnapshotSidecar(TEST_SESSION_ID, html);

    // Read the raw bytes back and gunzip.
    const { readFile } = await import('fs/promises');
    const compressed = await readFile(result.path);
    const decompressed = await gunzipAsync(compressed);
    expect(decompressed.toString('utf8')).toBe(html);
  });

  it('filename ends with .html.gz', async () => {
    const result = await writeDomSnapshotSidecar(TEST_SESSION_ID, '<html/>');
    expect(result.path).toMatch(/\.html\.gz$/);
  });

  it('concurrent DOM snapshot writes do not collide', async () => {
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writeDomSnapshotSidecar(TEST_SESSION_ID, `<html>${i}</html>`),
      ),
    );

    const paths = results.map((r) => r.path);
    const uniquePaths = new Set(paths);
    expect(uniquePaths.size).toBe(N);
  });
});
