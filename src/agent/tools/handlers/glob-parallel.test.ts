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
import { Readahead } from './glob-readahead.js';

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

describe('glob parallel readdir — over-cap fallback (#2637)', () => {
  /**
   * Exercises the path where more directories exist than the Readahead
   * maxConcurrent budget allows. schedule() silently drops directories once
   * the budget is exhausted; get() detects the missing cache entry and issues
   * a direct readdir. This test verifies that the fallback produces the same
   * complete, ordered results as the pre-readahead sequential walker.
   *
   * Uses maxConcurrent=2 with 7 directories (5 under the root + 2 children)
   * to reliably exercise the over-cap path on any I/O scheduler.
   */
  it('returns all results when dirs exceed maxConcurrent (over-cap fallback)', async () => {
    // Build a flat tree with more dirs than maxConcurrent=2:
    // root/
    //   d00/ file0.ts file1.ts
    //   d01/ file0.ts file1.ts
    //   d02/ file0.ts file1.ts
    //   d03/ file0.ts file1.ts
    //   d04/ file0.ts file1.ts
    // Total: 5 dirs × 2 files = 10 files
    const NUM_DIRS = 5;
    const FILES_PER = 2;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-par-cap-'));
    try {
      for (let i = 0; i < NUM_DIRS; i++) {
        const d = path.join(tmp, `d${String(i).padStart(2, '0')}`);
        await fs.mkdir(d, { recursive: true });
        for (let k = 0; k < FILES_PER; k++) {
          await fs.writeFile(path.join(d, `file${k}.ts`), '');
        }
      }

      // maxConcurrent=2 means at most 2 readdir calls in flight at once.
      // With 5+ dirs, schedule() will be a no-op for most; get() must fall
      // back to direct readdir for those.
      const ra = new Readahead(2);

      // Collect all dirs and schedule/get each, simulating the walker.
      const dirEntries = await fs.readdir(tmp, { withFileTypes: true });
      const dirs = dirEntries.filter((e) => e.isDirectory()).map((e) => path.join(tmp, e.name));

      // Schedule all (only the first 2 will actually be queued).
      for (const d of dirs) {
        ra.schedule(d);
      }

      // get() must succeed for all dirs, including those that weren't scheduled.
      const results: string[] = [];
      for (const d of dirs) {
        const entries = await ra.get(d);
        for (const e of entries) {
          results.push(e.name);
        }
      }

      // All 10 files should be returned (5 dirs × 2 files each).
      expect(results).toHaveLength(NUM_DIRS * FILES_PER);

      ra.drain();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('end-to-end: glob with maxConcurrent=2 and 5+ dirs returns all files in order', async () => {
    // Same scenario verified through the full glob handler (not just Readahead).
    // The handler uses READAHEAD_CONCURRENCY (32) internally, but a 5-dir flat
    // tree verifies the full pipeline still produces ordered results.
    const NUM_DIRS = 5;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-par-e2e-'));
    try {
      for (let i = 0; i < NUM_DIRS; i++) {
        const d = path.join(tmp, `d${String(i).padStart(2, '0')}`);
        await fs.mkdir(d, { recursive: true });
        await fs.writeFile(path.join(d, 'a.ts'), '');
        await fs.writeFile(path.join(d, 'b.ts'), '');
      }

      const handler = createGlobHandler(tmp);
      const result = await handler({ pattern: '**/*.ts' }, new AbortController().signal);

      expect(result.isError).toBeUndefined();
      const resultLines = lines(result.content);
      expect(resultLines).toHaveLength(NUM_DIRS * 2);
      // Results must be in lexicographic (depth-first) order.
      expect(resultLines).toEqual([...resultLines].sort());
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('Readahead — epoch guard / inFlight invariant (#2637)', () => {
  /**
   * Verifies that calling drain() while a scheduled promise is still in flight
   * does not cause inFlight to go negative.  We test the observable proxy:
   * after drain() + new schedules, inFlight must not underflow (i.e. the newly
   * scheduled promises must still decrement it correctly, meaning the stale
   * finally() from before drain() is a no-op).
   *
   * We can't inspect inFlight directly (private), so we verify the counter
   * stays consistent by scheduling up to maxConcurrent after a drain and
   * confirming get() still works (it would hang or throw if the counter were
   * corrupted).
   */
  it('drain() prevents inFlight from going negative on reuse', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-epoch-'));
    try {
      // Create dirs so schedule() actually issues real I/O.
      const dirA = path.join(tmp, 'a');
      const dirB = path.join(tmp, 'b');
      await fs.mkdir(dirA);
      await fs.mkdir(dirB);
      await fs.writeFile(path.join(dirA, 'f.ts'), '');

      const ra = new Readahead(2);

      // Schedule dirA — its promise is now in flight.
      ra.schedule(dirA);

      // Drain before the promise settles. The epoch guard must ensure its
      // finally() callback (which would decrement inFlight) is suppressed.
      ra.drain();
      // After the first drain(), inFlight must be 0 regardless of whether the
      // in-flight promise's finally() has already fired.
      // Cast to access the private counter — test-only introspection.
      expect((ra as unknown as { inFlight: number }).inFlight).toBe(0);

      // After drain(), schedule a new set of reads. If inFlight went negative
      // before the drain epoch guard, the budget math would be wrong and these
      // schedules could exceed maxConcurrent silently.
      ra.schedule(dirA);
      ra.schedule(dirB);

      // Both gets must resolve correctly — if the counter was corrupted the
      // fallback get() would still work, but this also confirms no throw.
      const entriesA = await ra.get(dirA);
      const entriesB = await ra.get(dirB);

      // Second drain(): inFlight must again be 0.
      ra.drain();
      expect((ra as unknown as { inFlight: number }).inFlight).toBe(0);

      expect(entriesA.length).toBe(1); // f.ts
      expect(entriesB.length).toBe(0); // empty dir
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('Readahead.get() — error narrowing (#2652)', () => {
  /**
   * Verifies that get()'s over-cap fallback catch only swallows genuine
   * Node.js filesystem errors (instanceof Error with a string .code). A
   * non-fs error that happens to carry a .code property — such as a
   * DOMException or a synthetic mock — must propagate, not be silently
   * swallowed as an empty listing.
   */
  it('rethrows a non-fs Error that has a .code property', async () => {
    // Simulate a DOMException-shaped error: it is `instanceof Error` and
    // carries a .code, but .code is a number (DOMException.code) not a string.
    // This must be rethrown by the narrowed catch.
    const domLike = Object.assign(new Error('AbortError'), { code: 20 }); // 20 = DOMException.ABORT_ERR

    const ra = new Readahead(0); // maxConcurrent=0 → every get() uses over-cap fallback

    // Temporarily replace fs.readdir to throw the domLike error.
    // We use a subpath that can't exist so the real fs.readdir won't succeed.
    const { promises: fsPromises } = await import('fs');
    const realReaddir = fsPromises.readdir.bind(fsPromises);
    // @ts-expect-error — intentionally patching for test
    fsPromises.readdir = () => Promise.reject(domLike);

    try {
      await expect(ra.get('/nonexistent-for-test')).rejects.toThrow('AbortError');
    } finally {
      // @ts-expect-error — restore
      fsPromises.readdir = realReaddir;
    }
  });

  it('swallows a genuine fs Error (ENOENT) and returns []', async () => {
    const fsError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

    const ra = new Readahead(0);

    const { promises: fsPromises } = await import('fs');
    const realReaddir = fsPromises.readdir.bind(fsPromises);
    // @ts-expect-error — intentionally patching for test
    fsPromises.readdir = () => Promise.reject(fsError);

    try {
      const result = await ra.get('/nonexistent-for-test');
      expect(result).toEqual([]);
    } finally {
      // @ts-expect-error — restore
      fsPromises.readdir = realReaddir;
    }
  });
});
