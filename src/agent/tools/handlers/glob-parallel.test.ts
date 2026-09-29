/**
 * Tests for the order-preserving parallel readdir introduced in #2586.
 *
 * These tests verify:
 *   1. Ordering: results with the parallel walker are byte-identical to the
 *      sequential walker on a fixture tree large enough to exercise concurrency
 *      (many directories hit simultaneously).
 *   2. Cap behaviour: the 500-entry cap is respected even when reads are
 *      in-flight in parallel.
 *   3. Abort behaviour: an abort mid-walk returns "Search aborted" as before.
 *
 * Run with: pnpm test src/agent/tools/handlers/glob-parallel.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createGlobHandler } from './glob.js';

/** Helper: collect lines from content, stripping the cap trailer if present. */
function lines(content: string): string[] {
  return content
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('[results capped'));
}

/**
 * Build a synthetic tree large enough that the readahead concurrency limit
 * (32) is exercised: TOP_DIRS top-level dirs each containing MID_DIRS
 * subdirs each containing FILES_PER_DIR files.
 *
 * Total directories  : TOP_DIRS * MID_DIRS  = 10 * 20 = 200
 * Total files        : 200 * FILES_PER_DIR  = 200 * 2 = 400
 *
 * 200 directories saturates the default concurrency=32 budget many times over.
 * 400 files stays under the 500-entry cap so ordering tests see all results.
 */
const TOP_DIRS = 10;
const MID_DIRS = 20;
const FILES_PER_DIR = 2;

describe('glob parallel readdir — ordering (#2586)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-par-'));

    for (let i = 0; i < TOP_DIRS; i++) {
      for (let j = 0; j < MID_DIRS; j++) {
        const dir = path.join(root, `top${String(i).padStart(2, '0')}`, `mid${String(j).padStart(2, '0')}`);
        await fs.mkdir(dir, { recursive: true });
        for (let k = 0; k < FILES_PER_DIR; k++) {
          await fs.writeFile(path.join(dir, `file${k}.ts`), '');
        }
      }
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns results in depth-first walk order (byte-identical to sequential)', async () => {
    const handler = createGlobHandler(root);
    const signal = () => new AbortController().signal;

    // Run twice — both runs should produce the same ordered output because
    // the walker is depth-first regardless of which readahead I/O finishes
    // first.
    const r1 = await handler({ pattern: '**/*.ts' }, signal());
    const r2 = await handler({ pattern: '**/*.ts' }, signal());

    expect(r1.isError).toBeUndefined();
    expect(r2.isError).toBeUndefined();

    const l1 = lines(r1.content);
    const l2 = lines(r2.content);

    // Deterministic count (400 total — under the 500 cap).
    expect(l1).toHaveLength(TOP_DIRS * MID_DIRS * FILES_PER_DIR);

    // Both runs produce the same order.
    expect(l1).toEqual(l2);

    // Results are in lexicographic (depth-first) order.
    const sorted = [...l1].sort();
    expect(l1).toEqual(sorted);
  });

  it('applies the 500-entry cap and still returns results in order', async () => {
    // Add extra files so total exceeds 500. The fixture has 400 files; we
    // need at least 101 more. Use zzz- prefix so they sort last and do not
    // affect which first 500 entries are returned in the ordering assertion.
    const extraDir = path.join(root, 'zzz-extra');
    await fs.mkdir(extraDir);
    for (let i = 0; i < 120; i++) {
      await fs.writeFile(path.join(extraDir, `extra${String(i).padStart(3, '0')}.ts`), '');
    }

    // 400 + 120 = 520 total files → should cap at 500.
    const handler = createGlobHandler(root);
    const result = await handler({ pattern: '**/*.ts' }, new AbortController().signal);

    expect(result.isError).toBeUndefined();
    const resultLines = lines(result.content);
    expect(resultLines).toHaveLength(500);
    expect(result.content).toContain('[results capped at 500 entries]');

    // The capped 500 must be in depth-first order.
    const sorted = [...resultLines].sort();
    expect(resultLines).toEqual(sorted);
  });

  it('abort mid-walk returns "Search aborted"', async () => {
    const ac = new AbortController();
    const handler = createGlobHandler(root);

    // Start the walk and abort immediately.
    const pending = handler({ pattern: '**/*.ts' }, ac.signal);
    ac.abort();
    const result = await pending;

    expect(result).toEqual({ content: 'Search aborted', isError: true });
  });

  it('pre-aborted signal returns "Search aborted" without walking', async () => {
    const ac = new AbortController();
    ac.abort();

    const handler = createGlobHandler(root);
    const result = await handler({ pattern: '**/*.ts' }, ac.signal);

    expect(result).toEqual({ content: 'Search aborted', isError: true });
  });

  it('completes correctly on a tree smaller than concurrency limit', async () => {
    // A tiny tree: 3 dirs, 2 files each. Much less than READAHEAD_CONCURRENCY.
    const tiny = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-par-tiny-'));
    try {
      for (let i = 0; i < 3; i++) {
        await fs.mkdir(path.join(tiny, `d${i}`));
        for (let k = 0; k < 2; k++) {
          await fs.writeFile(path.join(tiny, `d${i}`, `f${k}.ts`), '');
        }
      }

      const handler = createGlobHandler(tiny);
      const result = await handler({ pattern: '**/*.ts' }, new AbortController().signal);

      expect(result.isError).toBeUndefined();
      const resultLines = lines(result.content);
      expect(resultLines).toHaveLength(6);
      expect(resultLines).toEqual([...resultLines].sort());
    } finally {
      await fs.rm(tiny, { recursive: true, force: true });
    }
  });
});
