/**
 * validateCwd canonicalises with the NATIVE realpath, the same one the tool
 * handlers' containment uses (path-policy.roots realpathSafe). On Windows the
 * JS realpath keeps 8.3 short names (`C:\Users\RUNNER~1`) and the native one
 * returns the long form, so mixing them makes policy and enforcement disagree
 * about which directory the session is. The fs double makes the two
 * implementations distinguishable on every platform.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const LONG = 'C:\\Users\\runneradmin\\ws';
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const js = Object.assign(vi.fn(() => 'C:\\Users\\RUNNER~1\\ws'), { native: vi.fn(() => LONG) });
  return { ...real, realpathSync: js, statSync: vi.fn(() => ({ isDirectory: () => true })) };
});

const { validateCwd } = await import('./acp.params.js');

describe('validateCwd canonical form', () => {
  it('returns the native realpath (long name), not the JS one (8.3 short name)', () => {
    // Any platform-absolute input: the fs double decides what it canonicalises to.
    expect(validateCwd(path.join(os.tmpdir(), 'ws'))).toBe(LONG);
  });
});
