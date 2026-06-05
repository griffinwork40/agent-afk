/**
 * F5 — migrateDirOnce EXDEV fallback test.
 *
 * Lives in its own file because vi.mock() is hoisted to module scope and
 * replaces 'fs' for the entire module graph of this file. Isolating here
 * prevents the mock from contaminating the broader paths.test.ts suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as realFs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Mock strategy:
//   We mock 'fs' so that renameSync throws EXDEV on its first call.
//   All other fs operations (existsSync, mkdirSync, cpSync, rmSync, etc.)
//   delegate to the real implementation so filesystem setup/assertions work.
//   vi.mock is hoisted above imports by vitest so the mock is in place
//   when paths.ts is first imported.
// ---------------------------------------------------------------------------

let throwExdev = false;

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    renameSync: (...args: Parameters<typeof original.renameSync>) => {
      if (throwExdev) {
        throwExdev = false; // one-shot: only throw once
        const err = new Error(
          'EXDEV: cross-device link not permitted',
        ) as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      return original.renameSync(...args);
    },
  };
});

// Import paths AFTER the mock is established (hoisting ensures this).
import { ensureSessionsMigrated, getSessionsDir } from './paths.js';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-exdev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
  delete process.env['AFK_HOME'];
});

afterEach(() => {
  if (realFs.existsSync(tmpHome)) realFs.rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
  else delete process.env['HOME'];
  delete process.env['AFK_HOME'];
});

describe('migrateDirOnce — EXDEV fallback (F5)', () => {
  it('does NOT throw when renameSync fails with EXDEV — falls back to copy+remove', () => {
    // 1. Create legacy sessions dir with a sentinel file.
    const legacy = join(tmpHome, '.afk', 'sessions');
    realFs.mkdirSync(legacy, { recursive: true });
    realFs.writeFileSync(join(legacy, 'sentinel.json'), '{"migrated":true}');

    // 2. Confirm new path does not yet exist.
    const modern = getSessionsDir();
    expect(realFs.existsSync(modern)).toBe(false);

    // 3. Arm the EXDEV throw for the next renameSync call.
    throwExdev = true;

    // 4. Should complete without throwing.
    expect(() => ensureSessionsMigrated()).not.toThrow();

    // 5. Destination should contain the sentinel (cpSync fallback succeeded).
    expect(realFs.existsSync(modern)).toBe(true);
    expect(realFs.existsSync(join(modern, 'sentinel.json'))).toBe(true);
    expect(
      JSON.parse(realFs.readFileSync(join(modern, 'sentinel.json'), 'utf-8')),
    ).toEqual({ migrated: true });

    // 6. Source should be gone (rmSync fallback succeeded).
    expect(realFs.existsSync(legacy)).toBe(false);
  });
});
