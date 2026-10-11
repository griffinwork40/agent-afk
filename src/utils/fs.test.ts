/**
 * Unit tests for src/utils/fs.ts
 *
 * Covers:
 *   - pathExists: returns true for an existing file
 *   - pathExists: returns true for an existing directory
 *   - pathExists: returns false for a non-existent path
 *   - pathExists: returns false for a path inside a non-existent directory
 *   - pathExists: never throws
 *
 * @module utils/fs.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathExists } from './fs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'afk-fs-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pathExists', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns true for an existing file', async () => {
    const p = join(dir, 'exists.txt');
    writeFileSync(p, 'hello');
    expect(await pathExists(p)).toBe(true);
  });

  it('returns true for an existing directory', async () => {
    expect(await pathExists(dir)).toBe(true);
  });

  it('returns false for a non-existent file path', async () => {
    const p = join(dir, 'does-not-exist.txt');
    expect(await pathExists(p)).toBe(false);
  });

  it('returns false when the parent directory does not exist', async () => {
    const p = join(dir, 'no-such-dir', 'file.txt');
    expect(await pathExists(p)).toBe(false);
  });

  it('never throws — returns false for any inaccessible or missing path', async () => {
    // An implausible path deep in a nonexistent hierarchy: should never throw.
    const p = join(dir, 'a', 'b', 'c', 'd', 'nope.json');
    await expect(pathExists(p)).resolves.toBe(false);
  });
});
