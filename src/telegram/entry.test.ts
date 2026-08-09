/**
 * Regression guard for the src/telegram.ts → src/telegram/entry.ts split.
 *
 * The defect this locks out: src/telegram.ts used to define main() AND call it
 * at module load, so importing any part of the bot booted a daemon. That is why
 * version-check.ts was extracted in the first place ("so it can be imported in
 * tests without triggering src/telegram.ts's module-level main() call") and why
 * the entrypoint had zero tests. entry.ts exports main() without calling it;
 * only the shim invokes it.
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const { botCtor } = vi.hoisted(() => ({ botCtor: vi.fn() }));
vi.mock('./bot.js', () => ({ TelegramBot: botCtor }));

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('telegram entrypoint split', () => {
  it('exports main() without invoking it on import', async () => {
    const mod = await import('./entry.js');
    expect(typeof mod.main).toBe('function');
    // If main() ran at import time it would construct a TelegramBot (or exit
    // the worker on the missing-credential path long before reaching here).
    expect(botCtor).not.toHaveBeenCalled();
  });

  it('keeps src/telegram.ts at its exact path', () => {
    // Invariant: this path is an esbuild entry point (scripts/build-dist.mjs →
    // dist/telegram.mjs) AND the third candidate in resolveEntrypoint's spawn
    // ladder (telegram/manager.ts). Moving or deleting it breaks the published
    // bundle and the dev/vitest spawn path — neither of which any other test
    // would catch, because both resolve the path at runtime.
    expect(existsSync(join(repoRoot, 'src', 'telegram.ts'))).toBe(true);
  });

  it('keeps the shebang on the spawned entrypoint', () => {
    // The dev/vitest layout spawns src/telegram.ts directly; build-dist
    // re-adds a shebang to dist/telegram.mjs, but the source path has no such
    // post-processing step.
    const source = readFileSync(join(repoRoot, 'src', 'telegram.ts'), 'utf-8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
