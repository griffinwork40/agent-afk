/**
 * Regression tests for resolveEntrypoint().
 *
 * Three layouts must work: bundled (dist/telegram.mjs sibling of cli.mjs),
 * tsc-only (dist/telegram/manager.js + dist/telegram.js), and dev/vitest
 * (src/telegram/manager.ts + src/telegram.ts). Priority matters: bundled
 * layout wins because in a published install dist/telegram/ artifacts also
 * exist but reference unbundled deps the package no longer ships.
 */

import { describe, expect, it } from 'vitest';
import { resolveEntrypoint } from './manager.js';

describe('resolveEntrypoint', () => {
  it('resolves bundled layout (sibling .mjs)', () => {
    // dist/cli.mjs imports manager from dist/telegram.mjs's internals via
    // the bundle — but at runtime __dirname is dist/, and entry is dist/telegram.mjs.
    const exists = (p: string) => p === '/pkg/dist/telegram.mjs';
    expect(resolveEntrypoint('/pkg/dist', exists)).toBe('/pkg/dist/telegram.mjs');
  });

  it('prefers bundled .mjs over unbundled .js when both exist', () => {
    // Published bundles ship dist/telegram/ artifacts alongside the bundle.
    // Spawning the unbundled dist/telegram.js would re-import deps the
    // bundle inlined, so the sibling .mjs must win.
    const exists = (p: string) => p === '/pkg/dist/telegram.mjs' || p === '/pkg/telegram.js';
    expect(resolveEntrypoint('/pkg/dist', exists)).toBe('/pkg/dist/telegram.mjs');
  });

  it('resolves tsc layout (one dir up, .js)', () => {
    // Local pnpm build: manager.js is at dist/telegram/manager.js,
    // entry is dist/telegram.js. join() normalizes ../ in paths.
    const exists = (p: string) => p === '/pkg/dist/telegram.js';
    expect(resolveEntrypoint('/pkg/dist/telegram', exists)).toBe('/pkg/dist/telegram.js');
  });

  it('resolves dev layout (one dir up, .ts)', () => {
    const exists = (p: string) => p === '/repo/src/telegram.ts';
    expect(resolveEntrypoint('/repo/src/telegram', exists)).toBe('/repo/src/telegram.ts');
  });

  it('throws with searched paths when no entry exists', () => {
    expect(() => resolveEntrypoint('/nowhere', () => false)).toThrow(
      /Telegram entrypoint not found.*\/nowhere\/telegram\.mjs.*telegram\.js.*telegram\.ts/,
    );
  });
});
