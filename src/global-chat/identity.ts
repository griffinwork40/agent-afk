/**
 * File-backed identity store for the global-chat client.
 *
 * Rules:
 *   - Missing file  → load() returns null; create() proceeds.
 *   - Corrupt file  → load()/create()/rename()/sign() throw a generic error.
 *   - create() never overwrites any existing or corrupt file.
 *   - All mutations serialise through a promise chain (no interleaved writes).
 *   - atomicWriteFileAsync mode 0600 / mkdirMode 0700 for every write.
 *   - Self-verification on every load: sign a known canonical with the stored
 *     private key and verify with the stored public key; mismatch → corrupt.
 *
 * @module global-chat/identity
 */

import { readFile } from 'node:fs/promises';
import { atomicWriteFileAsync } from '../utils/atomic-write.js';
import { getGlobalChatIdentityPath } from '../paths.global-chat.js';
import {
  generateKeyPair,
  importPrivateKey,
  sign,
  verify,
  deriveTag,
} from './crypto.js';
import { validateName } from './names.js';
import { NAME_CHANGE_INTERVAL_MS } from './protocol.js';
import type { ChatIdentity, IdentityResult, IdentityStore } from './client-types.js';

// ---------------------------------------------------------------------------
// Stored record shape (private — never exported)
// ---------------------------------------------------------------------------

interface IdentityRecord {
  /** Format version; must equal 1. */
  version: 1;
  /** Hex-encoded raw 32-byte Ed25519 public key. */
  pubkey: string;
  /** Hex-encoded PKCS8-encoded Ed25519 private key. */
  privateKeyPkcs8: string;
  /** First 4 hex chars of SHA-256(raw public key bytes). */
  tag: string;
  /** Display name matching NAME_PATTERN. */
  name: string;
  /** Epoch ms of the most recent name change (set by injected clock on create). */
  nameChangedAt: number;
  /** Highest notice version accepted by this identity, or 0 if none. */
  noticeVersion: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface IdentityStoreOptions {
  /** Override the default identity file path (for tests). */
  filePath?: string;
  /** Override the clock source (for tests). */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical string used exclusively for self-verification on load. */
const SELF_VERIFY_CANONICAL = 'afk-global-chat/v1\nself-verify';

/** Generic error thrown for any corrupt or unreadable identity file. */
class IdentityCorruptError extends Error {
  constructor() { super('Identity storage is corrupt or unreadable'); }
}

function isValidRecord(v: unknown): v is IdentityRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r['version'] === 1 &&
    typeof r['pubkey'] === 'string' && /^[0-9a-f]{64}$/.test(r['pubkey']) &&
    typeof r['privateKeyPkcs8'] === 'string' && r['privateKeyPkcs8'].length > 0 &&
    typeof r['tag'] === 'string' && /^[0-9a-f]{4}$/.test(r['tag']) &&
    typeof r['name'] === 'string' && r['name'].length > 0 &&
    typeof r['nameChangedAt'] === 'number' && Number.isSafeInteger(r['nameChangedAt']) && r['nameChangedAt'] >= 0 &&
    typeof r['noticeVersion'] === 'number' && Number.isSafeInteger(r['noticeVersion']) && r['noticeVersion'] >= 0
  );
}

// ---------------------------------------------------------------------------
// FileIdentityStore
// ---------------------------------------------------------------------------

export class FileIdentityStore implements IdentityStore {
  readonly #filePath: string;
  readonly #now: () => number;
  /** Serializes all mutations so within-instance writes never interleave. */
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: IdentityStoreOptions = {}) {
    this.#filePath = opts.filePath ?? getGlobalChatIdentityPath();
    this.#now = opts.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------------
  // Internal: load and self-verify the record
  //
  // Returns null  → file is absent (ENOENT).
  // Throws        → file exists but is corrupt or unreadable.
  // -------------------------------------------------------------------------

  async #loadRecord(): Promise<IdentityRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Exists but unreadable (permissions, I/O error).
      throw new IdentityCorruptError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new IdentityCorruptError();
    }

    if (!isValidRecord(parsed)) throw new IdentityCorruptError();

    // Self-verify: sign a known canonical with the stored private key and
    // verify with the stored public key.  Also check the stored tag.
    try {
      const privateKey = await importPrivateKey(parsed.privateKeyPkcs8);
      const sig = await sign(SELF_VERIFY_CANONICAL, privateKey);
      const ok = await verify(SELF_VERIFY_CANONICAL, sig, parsed.pubkey);
      if (!ok) throw new IdentityCorruptError();
      const expectedTag = await deriveTag(parsed.pubkey);
      if (expectedTag !== parsed.tag) throw new IdentityCorruptError();
    } catch (err) {
      if (err instanceof IdentityCorruptError) throw err;
      throw new IdentityCorruptError();
    }

    return parsed;
  }

  // -------------------------------------------------------------------------
  // Internal: write helper
  // -------------------------------------------------------------------------

  async #write(record: IdentityRecord): Promise<void> {
    await atomicWriteFileAsync(
      this.#filePath,
      JSON.stringify(record),
      { mode: 0o600, mkdirMode: 0o700 },
    );
  }

  // -------------------------------------------------------------------------
  // Internal: serialize mutation through the queue
  // -------------------------------------------------------------------------

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    this.#queue = this.#queue.then(() => fn().then(resolve, reject));
    return result;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns null for missing file; throws for corrupt/unreadable file. */
  async load(): Promise<ChatIdentity | null> {
    const record = await this.#loadRecord();
    if (record === null) return null;
    return { pubkey: record.pubkey, tag: record.tag, name: record.name };
  }

  async create(name: string): Promise<IdentityResult> {
    return this.#enqueue(async () => {
      // Probe: absent → proceed; present (healthy or corrupt) → already_exists.
      let fileAbsent = false;
      try {
        await readFile(this.#filePath, 'utf-8');
        // File readable — healthy or corrupt, do not overwrite.
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          fileAbsent = true;
        }
        // Unreadable (non-ENOENT) — treat as existing to avoid overwriting.
      }
      if (!fileAbsent) {
        return { ok: false, code: 'already_exists' } satisfies IdentityResult;
      }

      const nameResult = validateName(name);
      if (!nameResult.ok) {
        return { ok: false, code: nameResult.code } satisfies IdentityResult;
      }

      const kp = await generateKeyPair();
      const tag = await deriveTag(kp.pubkey);
      const record: IdentityRecord = {
        version: 1,
        pubkey: kp.pubkey,
        privateKeyPkcs8: kp.privateKeyPkcs8,
        tag,
        name,
        nameChangedAt: this.#now(),
        noticeVersion: 0,
      };
      await this.#write(record);
      return { ok: true, identity: { pubkey: kp.pubkey, tag, name } } satisfies IdentityResult;
    });
  }

  async rename(name: string): Promise<IdentityResult> {
    return this.#enqueue(async () => {
      let record: IdentityRecord | null;
      try {
        record = await this.#loadRecord();
      } catch {
        return { ok: false, code: 'not_created' } satisfies IdentityResult;
      }
      if (record === null) {
        return { ok: false, code: 'not_created' } satisfies IdentityResult;
      }

      // Same name: no-op success.
      if (record.name === name) {
        return { ok: true, identity: { pubkey: record.pubkey, tag: record.tag, name } } satisfies IdentityResult;
      }

      const nameResult = validateName(name);
      if (!nameResult.ok) {
        return { ok: false, code: nameResult.code } satisfies IdentityResult;
      }

      // Enforce rate interval — no sentinel exception; always check.
      const now = this.#now();
      const elapsed = now - record.nameChangedAt;
      if (elapsed < NAME_CHANGE_INTERVAL_MS) {
        return {
          ok: false,
          code: 'name_change_too_soon',
          retryAfterMs: NAME_CHANGE_INTERVAL_MS - elapsed,
        } satisfies IdentityResult;
      }

      const updated: IdentityRecord = { ...record, name, nameChangedAt: now };
      await this.#write(updated);
      return { ok: true, identity: { pubkey: updated.pubkey, tag: updated.tag, name } } satisfies IdentityResult;
    });
  }

  async isNoticeAccepted(version: number): Promise<boolean> {
    const record = await this.#loadRecord();
    if (record === null) return false;
    return record.noticeVersion >= version;
  }

  async acceptNotice(version: number): Promise<void> {
    return this.#enqueue(async () => {
      let record: IdentityRecord | null;
      try { record = await this.#loadRecord(); } catch { return; }
      if (record === null) return;
      if (record.noticeVersion >= version) return;
      await this.#write({ ...record, noticeVersion: version });
    });
  }

  async disable(): Promise<void> {
    return this.#enqueue(async () => {
      let record: IdentityRecord | null;
      try { record = await this.#loadRecord(); } catch { return; }
      if (record === null) return;
      await this.#write({ ...record, noticeVersion: 0 });
    });
  }

  async sign(canonical: string): Promise<string> {
    const record = await this.#loadRecord();
    if (record === null) throw new Error('No identity: call create() first');
    const privateKey = await importPrivateKey(record.privateKeyPkcs8);
    return sign(canonical, privateKey);
  }
}
