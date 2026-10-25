/**
 * SSH public-key pattern carve-out on the typed read surface.
 *
 * Allow: a DIRECT `*.pub` child of the resolved `~/.ssh`. Deny: private keys,
 * bare `.pub`, subdirectories, traversal, suffix lookalikes, a `*.pub` symlink
 * to a private key, an `AFK_READ_DENYLIST` re-deny, and any `~/.ssh` that
 * resolves under another builtin floor. Portable: nothing here writes under
 * the real `~/.ssh` (non-existent leaves resolve through `safeRealpath`'s
 * walk-up), and the symlink / relocation cases use tmpdir fixtures against the
 * pure gate functions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { _resetReadDenylistCacheForTests, isReadDenied } from './read-denylist.js';
import { gateSshPubKeyDir, isSshPubKeyChild } from './read-denylist-carveout.js';
import { safeRealpath } from './write-denylist.js';

const ssh = join(homedir(), '.ssh');

beforeEach(() => {
  delete process.env['AFK_READ_DENYLIST'];
  delete process.env['AFK_HOME'];
  _resetReadDenylistCacheForTests();
});
afterEach(() => {
  delete process.env['AFK_READ_DENYLIST'];
  delete process.env['AFK_HOME'];
  _resetReadDenylistCacheForTests();
});

describe('isReadDenied — SSH public keys', () => {
  it.each(['id_ed25519.pub', 'id_rsa.pub', 'github@corp.pub', 'work-laptop.pub', 'x.pub'])(
    'allows ~/.ssh/%s',
    (name) => {
      expect(isReadDenied(join(ssh, name)).denied).toBe(false);
    },
  );

  it.each([
    'id_ed25519',
    'id_rsa',
    'github_key',
    '.pub',
    'id_rsa.pub.bak',
    'id_rsa.PUB.old',
    join('keys', 'x.pub'),
    join('x.pub', 'child'),
    join('x.pub', '..', 'id_rsa'),
    'authorized_keys',
  ])('denies ~/.ssh/%s', (rel) => {
    expect(isReadDenied(join(ssh, rel)).denied).toBe(true);
  });

  it('denies the ~/.ssh directory itself', () => {
    expect(isReadDenied(ssh).denied).toBe(true);
  });

  it('is re-deniable via AFK_READ_DENYLIST (listing ~/.ssh re-denies every key)', () => {
    process.env['AFK_READ_DENYLIST'] = '~/.ssh';
    _resetReadDenylistCacheForTests();
    expect(isReadDenied(join(ssh, 'id_ed25519.pub')).denied).toBe(true);
    expect(isReadDenied(join(ssh, 'config')).denied).toBe(true);
  });

  it('a single key can be re-denied by name', () => {
    process.env['AFK_READ_DENYLIST'] = join(ssh, 'secret.pub');
    _resetReadDenylistCacheForTests();
    expect(isReadDenied(join(ssh, 'secret.pub')).denied).toBe(true);
    expect(isReadDenied(join(ssh, 'other.pub')).denied).toBe(false);
  });

  it('a relocated AFK_HOME under ~/.ssh widens nothing', () => {
    process.env['AFK_HOME'] = join(ssh, 'afk');
    _resetReadDenylistCacheForTests();
    expect(isReadDenied(join(ssh, 'afk', 'config', 'mcp.json')).denied).toBe(true);
    expect(isReadDenied(join(ssh, 'afk', 'config', 'x.pub')).denied).toBe(true);
    expect(isReadDenied(join(ssh, 'id_rsa')).denied).toBe(true);
  });
});

describe('isSshPubKeyChild — symlink safety is the caller-resolved path', () => {
  let root: string;
  beforeEach(() => {
    root = safeRealpath(mkdtempSync(join(tmpdir(), 'afk-pubkey-')));
    mkdirSync(join(root, '.ssh'));
    writeFileSync(join(root, '.ssh', 'id_rsa'), 'PRIVATE');
    writeFileSync(join(root, '.ssh', 'real.pub'), 'ssh-ed25519 AAAA');
    symlinkSync(join(root, '.ssh', 'id_rsa'), join(root, '.ssh', 'foo.pub'));
    writeFileSync(join(root, 'outside.pub'), 'x');
    symlinkSync(join(root, 'outside.pub'), join(root, '.ssh', 'escape.pub'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a real .pub child qualifies', () => {
    const dir = join(root, '.ssh');
    expect(isSshPubKeyChild(safeRealpath(join(dir, 'real.pub')), dir)).toBe(true);
  });

  it('foo.pub -> id_rsa is judged as id_rsa and does NOT qualify', () => {
    const dir = join(root, '.ssh');
    expect(isSshPubKeyChild(safeRealpath(join(dir, 'foo.pub')), dir)).toBe(false);
  });

  it('a .pub symlink pointing OUT of the ssh dir does not qualify', () => {
    const dir = join(root, '.ssh');
    expect(isSshPubKeyChild(safeRealpath(join(dir, 'escape.pub')), dir)).toBe(false);
  });

  it('bare .pub and nested children do not qualify', () => {
    const dir = join(root, '.ssh');
    expect(isSshPubKeyChild(join(dir, '.pub'), dir)).toBe(false);
    expect(isSshPubKeyChild(join(dir, 'k', 'x.pub'), dir)).toBe(false);
  });
});

describe('gateSshPubKeyDir — per-entry provenance gate', () => {
  const src = '/home/u/.ssh';
  it('opens the resolved ssh dir when no other root contains it', () => {
    const entries = [
      { source: src, root: '/home/u/.ssh' },
      { source: '/home/u/.gnupg', root: '/home/u/.gnupg' },
    ];
    expect(gateSshPubKeyDir(entries, ['/home/u/.afk/config'], src)).toBe('/home/u/.ssh');
  });

  it('drops the pattern when ~/.ssh resolves under another builtin floor', () => {
    const entries = [
      { source: src, root: '/home/u/.gnupg/ssh' },
      { source: '/home/u/.gnupg', root: '/home/u/.gnupg' },
    ];
    expect(gateSshPubKeyDir(entries, [], src)).toBeUndefined();
  });

  it('drops the pattern when a derived AFK config root contains the ssh dir', () => {
    const entries = [{ source: src, root: '/home/u/.ssh' }];
    expect(gateSshPubKeyDir(entries, ['/home/u/.ssh'], src)).toBeUndefined();
  });

  it('fails closed when the ssh source is not present', () => {
    expect(gateSshPubKeyDir([{ source: '/x', root: '/x' }], [], src)).toBeUndefined();
  });
});
