/**
 * File-backed identity store for the global-chat client.
 *
 * Contract:
 *   - The private key is loaded once per operation and never held beyond the
 *     call that uses it; it is never returned to callers.
 *   - Corrupt or unreadable storage is surfaced as `load()` returning null
 *     and `create/rename/sign` returning `{ok:false,code:'not_created'}`.
 *     The file is NEVER overwritten to repair corruption; only successful
 *     mutations may write.
 *   - All mutations are serialized through a promise chain so concurrent
 *     calls within the same instance cannot interleave writes.
 *   - atomicWriteFile with mode 0600 and mkdirMode 0700 is used for every
 *     write so the private key is not briefly world-readable.
 *   - Self-verification: on every load the stored public key is used to
 *     verify a known canonical string signed with the stored private key.
 *     A key pair that fails verification is treated as corrupt.
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
  /** Hex-encoded raw 32-byte Ed25519 public key. */
  pubkey: string;
  /** Hex-encoded PKCS8-encoded Ed25519 private key. */
  privateKeyPkcs8: string;
  /** First 4 hex chars of SHA-256(raw public key bytes). */
  tag: string;
  /** Display name matching NAME_PATTERN. */
  name: string;
  /** Epoch ms of the most recent name change, or 0 on first create. */
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

function isValidRecord(v: unknown): v is IdentityRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['pubkey'] === 'string' && /^[0-9a-f]{64}$/.test(r['pubkey']) &&
    typeof r['privateKeyPkcs8'] === 'string' && r['privateKeyPkcs8'].length > 0 &&
    typeof r['tag'] === 'string' && /^[0-9a-f]{4}$/.test(r['tag']) &&
    typeof r['name'] === 'string' &&
    typeof r['nameChangedAt'] === 'number' && Number.isFinite(r['nameChangedAt']) &&
    typeof r['noticeVersion'] === 'number' && Number.isFinite(r['noticeVersion'])
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
  // -------------------------------------------------------------------------

  async #loadRecord(): Promise<IdentityRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Unreadable (permissions, I/O error) — do not throw, treat as absent.
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt JSON — do not overwrite, return null.
      return null;
    }
    if (!isValidRecord(parsed)) return null;

    // Self-verify: import the private key and sign; then verify with the
    // stored public key. This confirms the key pair is internally consistent.
    try {
      const privateKey = await importPrivateKey(parsed.privateKeyPkcs8);
      const sig = await sign(SELF_VERIFY_CANONICAL, privateKey);
      const ok = await verify(SELF_VERIFY_CANONICAL, sig, parsed.pubkey);
      if (!ok) return null;
      // Also verify stored tag matches the public key.
      const expectedTag = await deriveTag(parsed.pubkey);
      if (expectedTag !== parsed.tag) return null;
    } catch {
      return null;
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

  async load(): Promise<ChatIdentity | null> {
    const record = await this.#loadRecord();
    if (record === null) return null;
    return { pubkey: record.pubkey, tag: record.tag, name: record.name };
  }

  async create(name: string): Promise<IdentityResult> {
    return this.#enqueue(async () => {
      // Refuse to overwrite any existing (even corrupt) file.
      let exists = false;
      try {
        await readFile(this.#filePath, 'utf-8');
        exists = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Unreadable file — treat as existing to avoid overwriting.
          exists = true;
        }
      }
      if (exists) {
        return { ok: false, code: 'already_exists' } satisfies IdentityResult;
      }

      const nameResult = validateName(name);
      if (!nameResult.ok) {
        return { ok: false, code: nameResult.code } satisfies IdentityResult;
      }

      const kp = await generateKeyPair();
      const tag = await deriveTag(kp.pubkey);
      const record: IdentityRecord = {
        pubkey: kp.pubkey,
        privateKeyPkcs8: kp.privateKeyPkcs8,
        tag,
        name,
        nameChangedAt: 0,
        noticeVersion: 0,
      };
      await this.#write(record);
      return { ok: true, identity: { pubkey: kp.pubkey, tag, name } } satisfies IdentityResult;
    });
  }

  async rename(name: string): Promise<IdentityResult> {
    return this.#enqueue(async () => {
      const record = await this.#loadRecord();
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

      // Enforce rate interval: nameChangedAt === 0 means first create, skip check.
      const now = this.#now();
      if (record.nameChangedAt !== 0) {
        const elapsed = now - record.nameChangedAt;
        if (elapsed < NAME_CHANGE_INTERVAL_MS) {
          return {
            ok: false,
            code: 'name_change_too_soon',
            retryAfterMs: NAME_CHANGE_INTERVAL_MS - elapsed,
          } satisfies IdentityResult;
        }
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
      const record = await this.#loadRecord();
      if (record === null) return;
      if (record.noticeVersion >= version) return;
      await this.#write({ ...record, noticeVersion: version });
    });
  }

  async disable(): Promise<void> {
    return this.#enqueue(async () => {
      const record = await this.#loadRecord();
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
