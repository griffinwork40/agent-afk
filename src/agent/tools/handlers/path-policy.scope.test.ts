import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { decidePathAccess } from './path-policy.js';
import { resolveAndContain, wouldBeRestricted, _resetRootRealpathCacheForTests } from './_cwd-utils.js';
import { _setRealScratchRootsForTests, _resetScratchRootsCacheForTests } from './scratch-roots.js';
import { _resetReadDenylistCacheForTests } from './read-denylist.js';
import { _resetWriteDenylistCacheForTests } from './write-denylist.js';

let fixture: string;
let root: string;
let outside: string;
beforeEach(() => {
  fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'afk-path-scope-')));
  root = join(fixture, 'root');
  outside = join(fixture, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  _setRealScratchRootsForTests([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  _resetReadDenylistCacheForTests();
  _resetWriteDenylistCacheForTests();
  _resetRootRealpathCacheForTests();
  _resetScratchRootsCacheForTests();
  rmSync(fixture, { recursive: true, force: true });
});

function scope() { return { resolveBase: root, readRoots: [root], writeRoots: [root] }; }

describe('floor then actor roots', () => {
  for (const op of ['read', 'write'] as const) {
    it(`${op}: denies floor under bypass, unconfined and explicitly granted scope`, () => {
      const target = join(homedir(), '.ssh', 'id_ed25519');
      for (const actor of [undefined, { allowAll: true }, { ...scope(), readRoots: [homedir()], writeRoots: [homedir()] }]) {
        expect(decidePathAccess(target, op, actor)).toMatchObject({ kind: 'deny', reason: 'credential' });
      }
    });
    it(`${op}: relative anchoring, empty roots and fallback scope preserve confinement`, () => {
      expect(decidePathAccess('new/file', op, scope())).toMatchObject({ kind: 'allow', resolved: join(root, 'new/file') });
      expect(decidePathAccess(outside, op, scope())).toMatchObject({ kind: 'deny', reason: 'roots' });
      expect(decidePathAccess(root, op, { ...scope(), readRoots: [], writeRoots: [] })).toMatchObject({ kind: 'deny', reason: 'roots' });
      expect(decidePathAccess(outside, op, undefined, root)).toMatchObject({ kind: 'deny', reason: 'roots' });
      expect(decidePathAccess(outside, op, { readRoots: [], writeRoots: [] }).kind).toBe('allow');
    });
    it(`${op}: symlink escape including missing descendants stays denied`, () => {
      const link = join(root, 'escape');
      symlinkSync(outside, link, 'junction');
      expect(decidePathAccess(join(link, 'missing', 'file'), op, scope())).toMatchObject({ kind: 'deny', reason: 'roots' });
    });
    it(`${op}: custom floor beats explicitly granted root and scratch`, () => {
      vi.stubEnv(op === 'read' ? 'AFK_READ_DENYLIST' : 'AFK_WRITE_DENYLIST', outside);
      _resetReadDenylistCacheForTests();
      _resetWriteDenylistCacheForTests();
      _setRealScratchRootsForTests([outside]);
      expect(decidePathAccess(join(outside, 'secret'), op, { ...scope(), readRoots: [outside], writeRoots: [outside] }))
        .toMatchObject({ kind: 'deny', reason: 'credential' });
      expect(() => resolveAndContain(join(outside, 'secret'), scope(), op)).toThrow();
    });
  }

  it('read carve-out does not grant roots and never enables writing', () => {
    const target = join(homedir(), '.ssh', 'config');
    expect(decidePathAccess(target, 'read', scope())).toMatchObject({ kind: 'deny', reason: 'roots' });
    expect(decidePathAccess(target, 'write', { allowAll: true })).toMatchObject({ kind: 'deny', reason: 'credential' });
    vi.stubEnv('AFK_READ_DENYLIST', target);
    _resetReadDenylistCacheForTests();
    expect(decidePathAccess(target, 'read', { allowAll: true })).toMatchObject({ kind: 'deny', reason: 'credential' });
  });

  it('scratch is write-only; containment adapter deliberately excludes floor', () => {
    _setRealScratchRootsForTests([outside]);
    expect(decidePathAccess(outside, 'write', scope()).kind).toBe('allow');
    expect(decidePathAccess(outside, 'read', scope())).toMatchObject({ kind: 'deny', reason: 'roots' });
    const credential = join(homedir(), '.ssh', 'id_ed25519');
    expect(wouldBeRestricted(credential, { allowAll: true }, 'write').restricted).toBe(false);
    expect(decidePathAccess(credential, 'write', { allowAll: true })).toMatchObject({ kind: 'deny', reason: 'credential' });
  });
});
