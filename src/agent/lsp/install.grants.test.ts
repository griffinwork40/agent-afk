/**
 * Tests for install.grants — focusing on concurrent persistGrant correctness
 * (review finding F1: read-modify-write race via AsyncMutex).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createGrantStore } from './install.grants.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'afk-grants-test-'));
}

describe('createGrantStore', () => {
  let tmpDir: string;
  let grantsPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    grantsPath = path.join(tmpDir, 'grants.json');
  });

  it('hasGrant returns false when no file exists', async () => {
    const store = createGrantStore(grantsPath);
    expect(await store.hasGrant('typescript')).toBe(false);
  });

  it('persistGrant then hasGrant returns true', async () => {
    const store = createGrantStore(grantsPath);
    await store.persistGrant('typescript', ['typescript-language-server', 'typescript']);
    expect(await store.hasGrant('typescript')).toBe(true);
  });

  it('sequential persistGrant calls accumulate all grants', async () => {
    const store = createGrantStore(grantsPath);
    await store.persistGrant('typescript', ['typescript-language-server']);
    await store.persistGrant('python', ['pyright']);
    expect(await store.hasGrant('typescript')).toBe(true);
    expect(await store.hasGrant('python')).toBe(true);
  });

  it('F1: concurrent persistGrant calls do not drop either grant', async () => {
    // Before the fix, two concurrent calls both read the same empty snapshot
    // and the last writer silently dropped the other language's grant.
    const store = createGrantStore(grantsPath);
    await Promise.all([
      store.persistGrant('typescript', ['typescript-language-server', 'typescript']),
      store.persistGrant('python', ['pyright']),
    ]);
    // Both grants must survive — neither should be lost to a race.
    expect(await store.hasGrant('typescript')).toBe(true);
    expect(await store.hasGrant('python')).toBe(true);
  });

  it('F1: many concurrent persistGrant calls all land', async () => {
    const store = createGrantStore(grantsPath);
    const langs = Array.from({ length: 8 }, (_, i) => `lang${i}`);
    await Promise.all(langs.map((l) => store.persistGrant(l, [`${l}-server`])));
    for (const l of langs) {
      expect(await store.hasGrant(l), `missing grant for ${l}`).toBe(true);
    }
  });

  it('persistGrant overwrites an existing grant for the same language', async () => {
    const store = createGrantStore(grantsPath);
    await store.persistGrant('typescript', ['old-package']);
    await store.persistGrant('typescript', ['new-package']);
    expect(await store.hasGrant('typescript')).toBe(true);
    const raw = JSON.parse(fs.readFileSync(grantsPath, 'utf8')) as {
      grants: Record<string, { packages: string[] }>;
    };
    expect(raw.grants['typescript']?.packages).toEqual(['new-package']);
  });

  it('hasGrant returns false for an unknown language even after other grants exist', async () => {
    const store = createGrantStore(grantsPath);
    await store.persistGrant('typescript', ['typescript-language-server']);
    expect(await store.hasGrant('rust')).toBe(false);
  });
});
