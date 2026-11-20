import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileIdentityStore } from './identity.js';
import { generateKeyPair, deriveTag } from './crypto.js';
import { NAME_CHANGE_INTERVAL_MS } from './protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'afk-identity-test-'));
  filePath = join(dir, 'identity.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(now?: () => number): FileIdentityStore {
  return new FileIdentityStore({ filePath, now });
}

async function validRecord(name = 'alice', noticeVersion = 0, nameChangedAt = 0): Promise<string> {
  const kp = await generateKeyPair();
  const tag = await deriveTag(kp.pubkey);
  return JSON.stringify({ pubkey: kp.pubkey, privateKeyPkcs8: kp.privateKeyPkcs8, tag, name, nameChangedAt, noticeVersion });
}

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

describe('FileIdentityStore.load()', () => {
  it('returns null when file is missing', async () => {
    expect(await store().load()).toBeNull();
  });

  it('returns identity for a valid file', async () => {
    await writeFile(filePath, await validRecord('alice'));
    const id = await store().load();
    expect(id).not.toBeNull();
    expect(id!.name).toBe('alice');
    expect(id!.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(id!.tag).toMatch(/^[0-9a-f]{4}$/);
  });

  it('returns null for empty file without throwing', async () => {
    await writeFile(filePath, '');
    expect(await store().load()).toBeNull();
  });

  it('returns null for corrupt JSON without throwing', async () => {
    await writeFile(filePath, '{ not valid json !!');
    expect(await store().load()).toBeNull();
  });

  it('returns null for missing fields without throwing', async () => {
    await writeFile(filePath, JSON.stringify({ pubkey: 'aa'.repeat(32), name: 'alice' }));
    expect(await store().load()).toBeNull();
  });

  it('returns null for wrong pubkey length', async () => {
    const kp = await generateKeyPair();
    const tag = await deriveTag(kp.pubkey);
    await writeFile(filePath, JSON.stringify({ pubkey: kp.pubkey.slice(0, 32), privateKeyPkcs8: kp.privateKeyPkcs8, tag, name: 'alice', nameChangedAt: 0, noticeVersion: 0 }));
    expect(await store().load()).toBeNull();
  });

  it('returns null for mismatched tag', async () => {
    const kp = await generateKeyPair();
    await writeFile(filePath, JSON.stringify({ pubkey: kp.pubkey, privateKeyPkcs8: kp.privateKeyPkcs8, tag: '0000', name: 'alice', nameChangedAt: 0, noticeVersion: 0 }));
    expect(await store().load()).toBeNull();
  });

  it('returns null when private key does not match public key', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const tag = await deriveTag(kp1.pubkey);
    // pubkey from kp1 but privateKeyPkcs8 from kp2 — self-verify fails
    await writeFile(filePath, JSON.stringify({ pubkey: kp1.pubkey, privateKeyPkcs8: kp2.privateKeyPkcs8, tag, name: 'alice', nameChangedAt: 0, noticeVersion: 0 }));
    expect(await store().load()).toBeNull();
  });

  it('never throws even if file is unreadable (directory at path)', async () => {
    await mkdir(filePath);
    expect(await store().load()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe('FileIdentityStore.create()', () => {
  it('creates identity for valid name', async () => {
    const result = await store().create('alice');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe('alice');
    expect(result.identity.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.identity.tag).toMatch(/^[0-9a-f]{4}$/);
  });

  it('identity survives a round-trip load', async () => {
    const r = await store().create('bob');
    expect(r.ok).toBe(true);
    const id = await store().load();
    expect(id?.name).toBe('bob');
    if (r.ok) expect(id?.pubkey).toBe(r.identity.pubkey);
  });

  it('returns already_exists when file already present', async () => {
    await store().create('alice');
    const r2 = await store().create('bob');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('already_exists');
  });

  it('returns already_exists for corrupt file (never overwrites)', async () => {
    await writeFile(filePath, '{ bad json');
    const r = await store().create('alice');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('already_exists');
  });

  it('returns bad_name for invalid name', async () => {
    const r = await store().create('A B');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_name');
  });

  it('returns bad_name for name too short', async () => {
    const r = await store().create('a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_name');
  });

  it('returns bad_name for name too long', async () => {
    const r = await store().create('a'.repeat(17));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_name');
  });

  it('returns reserved_name for reserved names', async () => {
    for (const name of ['admin', 'system', 'relay']) {
      const freshPath = join(dir, `id-${name}.json`);
      const s = new FileIdentityStore({ filePath: freshPath });
      const r = await s.create(name);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('reserved_name');
    }
  });

  it('writes file with mode 0600', async () => {
    await store().create('alice');
    const { mode } = await import('node:fs/promises').then(fs => fs.stat(filePath));
    expect(mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// rename()
// ---------------------------------------------------------------------------

describe('FileIdentityStore.rename()', () => {
  it('returns not_created when no identity exists', async () => {
    const r = await store().rename('alice');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_created');
  });

  it('same name is a no-op returning success', async () => {
    await store().create('alice');
    const r = await store().rename('alice');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.name).toBe('alice');
  });

  it('renames successfully after interval', async () => {
    const t0 = 1_000_000;
    const s = store(() => t0);
    await s.create('alice');
    // Simulate name set at t0 (nameChangedAt = t0 after rename)
    const t1 = t0 + NAME_CHANGE_INTERVAL_MS + 1;
    const s2 = store(() => t1);
    // First rename sets nameChangedAt
    const r1 = await s2.rename('bob');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.identity.name).toBe('bob');
  });

  it('enforces rate interval on second rename', async () => {
    const t0 = 1_000_000;
    await store(() => t0).create('alice');
    // Rename once at t0 + interval + 1 (allowed)
    const t1 = t0 + NAME_CHANGE_INTERVAL_MS + 1;
    await store(() => t1).rename('bob');
    // Attempt rename too soon after bob
    const t2 = t1 + NAME_CHANGE_INTERVAL_MS - 1000;
    const r = await store(() => t2).rename('carol');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('name_change_too_soon');
      expect(typeof r.retryAfterMs).toBe('number');
      expect(r.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('returns bad_name for invalid new name', async () => {
    await store().create('alice');
    const r = await store().rename('Bad Name!');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_name');
  });

  it('identity is loadable after rename', async () => {
    const t0 = 1_000_000;
    await store(() => t0).create('alice');
    const t1 = t0 + NAME_CHANGE_INTERVAL_MS + 1;
    await store(() => t1).rename('bob');
    const id = await store().load();
    expect(id?.name).toBe('bob');
  });
});

// ---------------------------------------------------------------------------
// notice acceptance
// ---------------------------------------------------------------------------

describe('FileIdentityStore notice acceptance', () => {
  it('isNoticeAccepted returns false with no identity', async () => {
    expect(await store().isNoticeAccepted(1)).toBe(false);
  });

  it('isNoticeAccepted returns false before acceptance', async () => {
    await store().create('alice');
    expect(await store().isNoticeAccepted(1)).toBe(false);
  });

  it('acceptNotice then isNoticeAccepted returns true', async () => {
    await store().create('alice');
    await store().acceptNotice(1);
    expect(await store().isNoticeAccepted(1)).toBe(true);
  });

  it('higher version accepted covers lower check', async () => {
    await store().create('alice');
    await store().acceptNotice(3);
    expect(await store().isNoticeAccepted(1)).toBe(true);
    expect(await store().isNoticeAccepted(3)).toBe(true);
    expect(await store().isNoticeAccepted(4)).toBe(false);
  });

  it('acceptNotice is a no-op when no identity', async () => {
    await expect(store().acceptNotice(1)).resolves.toBeUndefined();
  });

  it('acceptNotice is idempotent', async () => {
    await store().create('alice');
    await store().acceptNotice(1);
    await store().acceptNotice(1);
    expect(await store().isNoticeAccepted(1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// disable()
// ---------------------------------------------------------------------------

describe('FileIdentityStore.disable()', () => {
  it('clears notice acceptance', async () => {
    await store().create('alice');
    await store().acceptNotice(1);
    await store().disable();
    expect(await store().isNoticeAccepted(1)).toBe(false);
  });

  it('preserves identity and key after disable', async () => {
    const r = await store().create('alice');
    await store().acceptNotice(1);
    await store().disable();
    const id = await store().load();
    expect(id).not.toBeNull();
    expect(id!.name).toBe('alice');
    if (r.ok) expect(id!.pubkey).toBe(r.identity.pubkey);
  });

  it('disable on missing store is a no-op', async () => {
    await expect(store().disable()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sign()
// ---------------------------------------------------------------------------

describe('FileIdentityStore.sign()', () => {
  it('throws when no identity', async () => {
    await expect(store().sign('test')).rejects.toThrow();
  });

  it('produces a verifiable signature', async () => {
    const r = await store().create('alice');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { verify: cryptoVerify } = await import('./crypto.js');
    const canonical = 'afk-global-chat/v1\nhello\nglobal\n1234\n' + r.identity.pubkey + '\nalice';
    const sig = await store().sign(canonical);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(await cryptoVerify(canonical, sig, r.identity.pubkey)).toBe(true);
  });

  it('signature is invalid for tampered canonical', async () => {
    const r = await store().create('alice');
    if (!r.ok) return;
    const { verify: cryptoVerify } = await import('./crypto.js');
    const canonical = 'afk-global-chat/v1\nhello\nglobal\n1234\n' + r.identity.pubkey + '\nalice';
    const sig = await store().sign(canonical);
    expect(await cryptoVerify(canonical + 'x', sig, r.identity.pubkey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: serialized mutations
// ---------------------------------------------------------------------------

describe('FileIdentityStore concurrency', () => {
  it('concurrent renames on same instance serialize without corruption', async () => {
    const t0 = 1_000_000;
    const s = store(() => t0);
    await s.create('alice');
    // Fire multiple renames concurrently — only the first real rename should
    // succeed; the rest are either no-ops (same name) or rate-limited.
    const results = await Promise.all([
      s.rename('alice'),
      s.rename('alice'),
      s.rename('alice'),
    ]);
    // All no-ops (same name) should return ok
    for (const r of results) expect(r.ok).toBe(true);
    const id = await s.load();
    expect(id).not.toBeNull();
  });

  it('concurrent acceptNotice calls are safe', async () => {
    const s = store();
    await s.create('alice');
    await Promise.all([s.acceptNotice(1), s.acceptNotice(1), s.acceptNotice(1)]);
    expect(await s.isNoticeAccepted(1)).toBe(true);
  });
});
