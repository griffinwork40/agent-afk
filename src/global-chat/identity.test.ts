import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
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

/** Builds a valid serialised record (version:1 included). */
async function validRecord(name = 'alice', acceptedNoticeVersion: number | null = null, nameChangedAt = 1_000_000): Promise<string> {
  const kp = await generateKeyPair();
  const tag = await deriveTag(kp.pubkey);
  return JSON.stringify({ version: 1, pubkey: kp.pubkey, privateKeyPkcs8: kp.privateKeyPkcs8, tag, name, nameChangedAt, acceptedNoticeVersion });
}

const CORRUPT = '{ bad json';

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

  it('throws for empty file', async () => {
    await writeFile(filePath, '');
    await expect(store().load()).rejects.toThrow();
  });

  it('throws for corrupt JSON', async () => {
    await writeFile(filePath, '{ not valid json !!');
    await expect(store().load()).rejects.toThrow();
  });

  it('throws for missing fields', async () => {
    await writeFile(filePath, JSON.stringify({ pubkey: 'aa'.repeat(32), name: 'alice' }));
    await expect(store().load()).rejects.toThrow();
  });

  it('throws for missing version field', async () => {
    const kp = await generateKeyPair();
    const tag = await deriveTag(kp.pubkey);
    // No version field
    await writeFile(filePath, JSON.stringify({ pubkey: kp.pubkey, privateKeyPkcs8: kp.privateKeyPkcs8, tag, name: 'alice', nameChangedAt: 1_000_000, acceptedNoticeVersion: null }));
    await expect(store().load()).rejects.toThrow();
  });

  it('throws for wrong pubkey length', async () => {
    const kp = await generateKeyPair();
    const tag = await deriveTag(kp.pubkey);
    await writeFile(filePath, JSON.stringify({ version: 1, pubkey: kp.pubkey.slice(0, 32), privateKeyPkcs8: kp.privateKeyPkcs8, tag, name: 'alice', nameChangedAt: 1_000_000, acceptedNoticeVersion: null }));
    await expect(store().load()).rejects.toThrow();
  });

  it('throws for mismatched tag', async () => {
    const kp = await generateKeyPair();
    await writeFile(filePath, JSON.stringify({ version: 1, pubkey: kp.pubkey, privateKeyPkcs8: kp.privateKeyPkcs8, tag: '0000', name: 'alice', nameChangedAt: 1_000_000, acceptedNoticeVersion: null }));
    await expect(store().load()).rejects.toThrow();
  });

  it('throws when private key does not match public key', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const tag = await deriveTag(kp1.pubkey);
    await writeFile(filePath, JSON.stringify({ version: 1, pubkey: kp1.pubkey, privateKeyPkcs8: kp2.privateKeyPkcs8, tag, name: 'alice', nameChangedAt: 1_000_000, acceptedNoticeVersion: null }));
    await expect(store().load()).rejects.toThrow();
  });

  it('throws for non-safe-integer nameChangedAt', async () => {
    const kp = await generateKeyPair();
    const tag = await deriveTag(kp.pubkey);
    await writeFile(filePath, JSON.stringify({ version: 1, pubkey: kp.pubkey, privateKeyPkcs8: kp.privateKeyPkcs8, tag, name: 'alice', nameChangedAt: 1.5, acceptedNoticeVersion: null }));
    await expect(store().load()).rejects.toThrow();
  });

  it('throws for invalid acceptedNoticeVersion (zero)', async () => {
    const kp = await generateKeyPair();
    const tag = await deriveTag(kp.pubkey);
    await writeFile(filePath, JSON.stringify({ version: 1, pubkey: kp.pubkey, privateKeyPkcs8: kp.privateKeyPkcs8, tag, name: 'alice', nameChangedAt: 1_000_000, acceptedNoticeVersion: 0 }));
    await expect(store().load()).rejects.toThrow();
  });

  it('throws for invalid acceptedNoticeVersion (negative)', async () => {
    const kp = await generateKeyPair();
    const tag = await deriveTag(kp.pubkey);
    await writeFile(filePath, JSON.stringify({ version: 1, pubkey: kp.pubkey, privateKeyPkcs8: kp.privateKeyPkcs8, tag, name: 'alice', nameChangedAt: 1_000_000, acceptedNoticeVersion: -1 }));
    await expect(store().load()).rejects.toThrow();
  });

  it('accepts null acceptedNoticeVersion', async () => {
    await writeFile(filePath, await validRecord('alice', null));
    const id = await store().load();
    expect(id).not.toBeNull();
  });

  it('accepts positive acceptedNoticeVersion', async () => {
    await writeFile(filePath, await validRecord('alice', 2));
    const id = await store().load();
    expect(id).not.toBeNull();
  });

  it('throws when file is unreadable (directory at path)', async () => {
    await mkdir(filePath);
    await expect(store().load()).rejects.toThrow();
  });

  it('error message is generic (no path or key contents)', async () => {
    await writeFile(filePath, '{ bad }');
    try {
      await store().load();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(filePath);
      expect(msg.length).toBeGreaterThan(0);
    }
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

  it('written record includes version:1', async () => {
    await store().create('alice');
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
  });

  it('written record has acceptedNoticeVersion null', async () => {
    await store().create('alice');
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.acceptedNoticeVersion).toBeNull();
  });

  it('nameChangedAt uses injected clock on create', async () => {
    const t0 = 9_999_999;
    await store(() => t0).create('alice');
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.nameChangedAt).toBe(t0);
  });

  it('returns already_exists when file already present', async () => {
    await store().create('alice');
    const r2 = await store().create('bob');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('already_exists');
  });

  it('rejects (throws) for corrupt file and leaves bytes intact', async () => {
    await writeFile(filePath, CORRUPT);
    await expect(store().create('alice')).rejects.toThrow();
    // Corrupt bytes must be unchanged
    const after = await readFile(filePath, 'utf-8');
    expect(after).toBe(CORRUPT);
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

  it('rejects (throws) for corrupt file and leaves bytes intact', async () => {
    await writeFile(filePath, CORRUPT);
    await expect(store().rename('alice')).rejects.toThrow();
    const after = await readFile(filePath, 'utf-8');
    expect(after).toBe(CORRUPT);
  });

  it('same name is a no-op returning success', async () => {
    const t0 = 1_000_000;
    await store(() => t0).create('alice');
    // Same name — no interval check needed
    const r = await store(() => t0).rename('alice');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.name).toBe('alice');
  });

  it('renames successfully after interval since create', async () => {
    const t0 = 1_000_000;
    await store(() => t0).create('alice');
    // t1 is past the interval from create time
    const t1 = t0 + NAME_CHANGE_INTERVAL_MS + 1;
    const r = await store(() => t1).rename('bob');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.name).toBe('bob');
  });

  it('enforces rate interval since create (too soon)', async () => {
    const t0 = 1_000_000;
    await store(() => t0).create('alice');
    // Attempt rename before interval has elapsed
    const t1 = t0 + NAME_CHANGE_INTERVAL_MS - 1000;
    const r = await store(() => t1).rename('bob');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('name_change_too_soon');
      expect(typeof r.retryAfterMs).toBe('number');
      expect(r.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('enforces rate interval on second rename', async () => {
    const t0 = 1_000_000;
    await store(() => t0).create('alice');
    // First rename: allowed (past interval from create)
    const t1 = t0 + NAME_CHANGE_INTERVAL_MS + 1;
    await store(() => t1).rename('bob');
    // Second rename too soon after first
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
    const t0 = 1_000_000;
    await store(() => t0).create('alice');
    const t1 = t0 + NAME_CHANGE_INTERVAL_MS + 1;
    const r = await store(() => t1).rename('Bad Name!');
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

  it('acceptNotice rejects zero version', async () => {
    await expect(store().acceptNotice(0)).rejects.toThrow();
  });

  it('acceptNotice rejects negative version', async () => {
    await expect(store().acceptNotice(-1)).rejects.toThrow();
  });

  it('acceptNotice rejects non-integer version', async () => {
    await expect(store().acceptNotice(1.5)).rejects.toThrow();
  });

  it('acceptNotice rejects (throws) for corrupt file and leaves bytes intact', async () => {
    await writeFile(filePath, CORRUPT);
    await expect(store().acceptNotice(1)).rejects.toThrow();
    const after = await readFile(filePath, 'utf-8');
    expect(after).toBe(CORRUPT);
  });

  it('isNoticeAccepted rejects (throws) for corrupt file', async () => {
    await writeFile(filePath, CORRUPT);
    await expect(store().isNoticeAccepted(1)).rejects.toThrow();
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

  it('written record has acceptedNoticeVersion null after disable', async () => {
    await store().create('alice');
    await store().acceptNotice(2);
    await store().disable();
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.acceptedNoticeVersion).toBeNull();
  });

  it('disable on missing store is a no-op', async () => {
    await expect(store().disable()).resolves.toBeUndefined();
  });

  it('disable rejects (throws) for corrupt file and leaves bytes intact', async () => {
    await writeFile(filePath, CORRUPT);
    await expect(store().disable()).rejects.toThrow();
    const after = await readFile(filePath, 'utf-8');
    expect(after).toBe(CORRUPT);
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

  it('sign error message is generic (no key contents)', async () => {
    // load() on a corrupt file still throws from #loadRecord; sign wraps further errors generically
    await writeFile(filePath, CORRUPT);
    try {
      await store().sign('test');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(filePath);
      expect(msg.length).toBeGreaterThan(0);
    }
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
    // All same-name renames — no-op success regardless of interval
    const results = await Promise.all([
      s.rename('alice'),
      s.rename('alice'),
      s.rename('alice'),
    ]);
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
