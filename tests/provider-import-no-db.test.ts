/**
 * Regression test for #2818: importing the handler graph must not open SQLite
 * databases as a side effect.
 *
 * Before the fix, `src/agent/providers/openai-compatible/index.ts` and
 * `src/agent/providers/anthropic-direct/provider-runtime.ts` both created
 * `MemoryStore` and `StateStore` instances in their class constructors, which
 * ran at module-eval time via module-scope singletons. Importing
 * `src/agent/tools/handlers/index.ts` (through `nesting.ts`) transitively
 * evaluated those modules and opened both DBs.
 *
 * This test verifies the fix: after the import, neither `kv/kv.db` nor
 * `memory/memory.db` exist in the redirected state dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpStateDir: string;

beforeEach(() => {
  tmpStateDir = mkdtempSync(join(tmpdir(), 'afk-no-db-test-'));
  // vi.stubEnv is the Vitest-idiomatic way to set env vars in tests;
  // vi.unstubAllEnvs() in afterEach automatically restores the originals.
  vi.stubEnv('AFK_STATE_DIR', tmpStateDir);
  // Reset the module registry so every dynamic import below gets a freshly
  // evaluated module graph that picks up our AFK_STATE_DIR override.
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  try { rmSync(tmpStateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('provider import does not open SQLite databases (#2818)', () => {
  it('importing the handler graph creates neither kv/kv.db nor memory/memory.db', async () => {
    // Dynamic import under a fresh module registry so AFK_STATE_DIR is
    // resolved at import time using our temp dir rather than a prior cached value.
    await import('../src/agent/tools/handlers/index.js');

    expect(existsSync(join(tmpStateDir, 'kv', 'kv.db')), 'kv.db must not be created at import time').toBe(false);
    expect(existsSync(join(tmpStateDir, 'memory', 'memory.db')), 'memory.db must not be created at import time').toBe(false);
  });

  it('importing the anthropic-direct provider creates no DB files', async () => {
    await import('../src/agent/providers/anthropic-direct/provider-runtime.js');

    expect(existsSync(join(tmpStateDir, 'kv', 'kv.db')), 'kv.db must not be created at import time').toBe(false);
    expect(existsSync(join(tmpStateDir, 'memory', 'memory.db')), 'memory.db must not be created at import time').toBe(false);
  });

  it('importing the openai-compatible provider creates no DB files', async () => {
    await import('../src/agent/providers/openai-compatible/index.js');

    expect(existsSync(join(tmpStateDir, 'kv', 'kv.db')), 'kv.db must not be created at import time').toBe(false);
    expect(existsSync(join(tmpStateDir, 'memory', 'memory.db')), 'memory.db must not be created at import time').toBe(false);
  });
});
