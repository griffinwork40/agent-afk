/**
 * Tests for assertInsideSandbox (sandbox-guard.ts).
 *
 * Verifies:
 *   - A path inside the sandbox home is accepted.
 *   - A path that IS the sandbox home (exact match) is accepted.
 *   - A path outside both home and cwd throws.
 *   - A sibling-prefix path (/tmp/x/homeEvil vs /tmp/x/home) is correctly
 *     rejected — this was the Windows-portability bug where trailingSlash('/')
 *     containment was wrong. The new path.relative()-based isInside() helper
 *     rejects sibling prefixes on all platforms.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertInsideSandbox } from './sandbox-guard.js';
import type { Environment } from '../types.js';

function makeEnv(home: string, cwd: string): Environment {
  return { label: 'test', home, cwd, launch: { env: {} } };
}

describe('assertInsideSandbox', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-sandbox-guard-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts a path that is exactly the sandbox home', () => {
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const cwd = join(tmp, 'cwd');
    mkdirSync(cwd, { recursive: true });
    // Exact match on home — should NOT throw.
    expect(() => assertInsideSandbox(home, makeEnv(home, cwd))).not.toThrow();
  });

  it('accepts a path inside the sandbox home', () => {
    const home = join(tmp, 'home');
    const child = join(home, 'subdir');
    mkdirSync(child, { recursive: true });
    const cwd = join(tmp, 'cwd');
    mkdirSync(cwd, { recursive: true });
    expect(() => assertInsideSandbox(child, makeEnv(home, cwd))).not.toThrow();
  });

  it('rejects a path outside both home and cwd', () => {
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const cwd = join(tmp, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const outside = join(tmp, 'outside');
    mkdirSync(outside, { recursive: true });
    expect(() => assertInsideSandbox(outside, makeEnv(home, cwd))).toThrow(
      /sandbox containment violation/,
    );
  });

  it('rejects a sibling-prefix path (old trailingSlash bug)', () => {
    // home = tmp/home, evil = tmp/homeEvil
    // Old trailingSlash check: real.startsWith(home + '/') was safe but
    // if the slash was already present we'd check real.startsWith('/tmp/home/')
    // which '/tmp/homeEvil/...' does NOT match — however the root bug was
    // trailingSlash used '/' hardcoded, breaking on Windows where sep is '\'.
    // The new isInside() uses path.relative() which is sep-aware.
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const cwd = join(tmp, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const sibling = join(tmp, 'homeEvil');
    mkdirSync(sibling, { recursive: true });
    expect(() => assertInsideSandbox(sibling, makeEnv(home, cwd))).toThrow(
      /sandbox containment violation/,
    );
  });

  it('throws ENOENT from realpathSync when env.home does not exist', () => {
    // realpathSync(env.home) is called without creating env.home first.
    // The function must propagate the ENOENT rather than swallowing it.
    const nonExistentHome = join(tmp, 'does-not-exist');
    const cwd = join(tmp, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const dir = join(cwd, 'subdir');
    mkdirSync(dir, { recursive: true });
    expect(() => assertInsideSandbox(dir, makeEnv(nonExistentHome, cwd))).toThrow(
      /ENOENT/,
    );
  });
});
