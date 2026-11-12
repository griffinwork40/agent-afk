import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { assertNotDenylisted, safeRealpath, _resetWriteDenylistCacheForTests } from './write-denylist.js';
import { decidePathAccess } from './path-policy.js';

// Invariant: native long names and plain short names must yield the same floor
// even on a host that has no Windows 8.3 names or /var alias available.
afterEach(() => { vi.restoreAllMocks(); _resetWriteDenylistCacheForTests(); });
describe('write denylist canonical spelling', () => {
  it('refuses a native target when the plain denylist has a different spelling', () => {
    const protectedPlain = safeRealpath(join(homedir(), '.ssh'));
    const protectedNative = join(tmpdir(), 'synthetic-native-home', '.ssh');
    const target = join(protectedNative, 'missing');
    const original = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((path) => {
      const absolute = resolve(String(path));
      if (absolute === protectedPlain) return protectedNative;
      if (absolute === target) return target;
      return original(path);
    });
    expect(() => assertNotDenylisted(target, 'file checkpoint')).toThrow(/protected path/);
    expect(decidePathAccess(target, 'write', { allowAll: true }))
      .toMatchObject({ kind: 'deny', reason: 'credential' });
  });
});
