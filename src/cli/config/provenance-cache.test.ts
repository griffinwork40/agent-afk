// Contract: the provenance cache is a per-pass memo over config-file reads. Two
// things must hold or it is worse than no cache at all: (1) a cached pass must
// return exactly what an uncached pass returns — a memo that changes an answer
// is a bug, not an optimization; (2) every disk read inside
// `resolveConfigProvenance` must route THROUGH the cache, or the menu render
// keeps re-reading the same four files per row (the finding this exists to fix).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProvenanceCache, NO_PROVENANCE_CACHE, type ProvenanceCache } from './provenance-cache.js';
import { resolveConfigProvenance } from './provenance.js';

let tmpRoot: string;
let cwdBefore: string;
let homeBefore: string | undefined;

/** Count how many times a resolution actually reaches the file system. */
function countingCache(): { cache: ProvenanceCache; reads: () => number } {
  const inner = createProvenanceCache();
  let reads = 0;
  return {
    reads: () => reads,
    cache: {
      raw: (file, compute) =>
        inner.raw(file, () => {
          reads += 1;
          return compute();
        }),
      validated: (file, compute) =>
        inner.validated(file, () => {
          reads += 1;
          return compute();
        }),
    },
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'afk-prov-cache-'));
  mkdirSync(join(tmpRoot, 'project'), { recursive: true });
  mkdirSync(join(tmpRoot, 'home', 'config'), { recursive: true });
  cwdBefore = process.cwd();
  process.chdir(join(tmpRoot, 'project'));
  homeBefore = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = join(tmpRoot, 'home');
  writeFileSync(
    join(tmpRoot, 'home', 'config', 'afk.config.json'),
    JSON.stringify({ model: 'sonnet', theme: 'dark', maxTokens: 4096 }),
    'utf8',
  );
});

afterEach(() => {
  process.chdir(cwdBefore);
  if (homeBefore === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = homeBefore;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('createProvenanceCache', () => {
  it('computes once per (kind, path) and replays the memo', () => {
    const cache = createProvenanceCache();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return { a: 1 };
    };
    expect(cache.raw('/f', compute)).toEqual({ a: 1 });
    expect(cache.raw('/f', compute)).toEqual({ a: 1 });
    expect(calls).toBe(1);
  });

  it('caches `undefined` — an absent or malformed file must not be re-read', () => {
    const cache = createProvenanceCache();
    let calls = 0;
    const missing = () => {
      calls += 1;
      return undefined;
    };
    cache.raw('/missing', missing);
    cache.raw('/missing', missing);
    expect(calls).toBe(1);
  });

  it('keeps raw and validated views of the same file apart', () => {
    // Same bytes, different questions: raw is what an edit replaces, validated
    // is what will load. One key space would let a raw hit answer a validated
    // read and misreport a coerced or rejected value.
    const cache = createProvenanceCache();
    expect(cache.raw('/f', () => ({ model: 'SONNET' }))).toEqual({ model: 'SONNET' });
    expect(cache.validated('/f', () => ({ model: 'sonnet' }))).toEqual({ model: 'sonnet' });
  });

  it('NO_PROVENANCE_CACHE computes every time', () => {
    let calls = 0;
    const compute = () => {
      calls += 1;
      return undefined;
    };
    NO_PROVENANCE_CACHE.raw('/f', compute);
    NO_PROVENANCE_CACHE.raw('/f', compute);
    expect(calls).toBe(2);
  });
});

describe('resolveConfigProvenance — cached batch resolution', () => {
  it('reads each file once for a whole batch of keys instead of once per key', () => {
    const shared = countingCache();
    for (const key of ['model', 'theme', 'maxTokens', 'permissionMode']) {
      resolveConfigProvenance(key, shared.cache);
    }
    // At most one raw read of the user file plus one validated read per tier
    // (project, user, legacy) — four regardless of how many keys are resolved.
    expect(shared.reads()).toBeLessThanOrEqual(4);

    const perKey = ['model', 'theme', 'maxTokens', 'permissionMode'].reduce((n, key) => {
      const c = countingCache();
      resolveConfigProvenance(key, c.cache);
      return n + c.reads();
    }, 0);
    expect(perKey).toBeGreaterThan(shared.reads());
  });

  it('returns byte-identical provenance with and without a cache', () => {
    writeFileSync(
      join(tmpRoot, 'project', 'afk.config.json'),
      JSON.stringify({ theme: 'light' }),
      'utf8',
    );
    const cache = createProvenanceCache();
    for (const key of ['model', 'theme', 'permissionMode']) {
      expect(resolveConfigProvenance(key, cache)).toEqual(resolveConfigProvenance(key));
    }
  });

  it('a fresh cache observes a write the previous cache predates', () => {
    // The menu builds one cache per render pass for exactly this reason: an edit
    // lands between renders, and the next pass must show the new value.
    const stale = createProvenanceCache();
    expect(resolveConfigProvenance('model', stale).effective).toBe('sonnet');
    writeFileSync(
      join(tmpRoot, 'home', 'config', 'afk.config.json'),
      JSON.stringify({ model: 'opus' }),
      'utf8',
    );
    expect(resolveConfigProvenance('model', stale).effective).toBe('sonnet'); // memoized
    expect(resolveConfigProvenance('model', createProvenanceCache()).effective).toBe('opus');
  });
});
