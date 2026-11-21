/**
 * File-backed mute store for the global-chat client.
 *
 * Contract:
 *   - The backing file (`<AFK config dir>/global-chat/mutes.json`, see
 *     `paths.global-chat.ts`) sits beside the identity file in the config
 *     dir, out of reach of the agent's file tools.
 *   - The backing file is a JSON array of `{ pubkey, name }` objects.
 *   - If the file is missing, `list()` returns `[]` without throwing.
 *   - If the file is corrupt (bad JSON or wrong shape), `list()` returns `[]`
 *     without throwing and WITHOUT overwriting the file. The file is only
 *     written on a successful `add` or `remove`.
 *   - All writes use `atomicWriteFileAsync` (mode 0600, mkdirMode 0700).
 *   - Mutations are serialized through a promise chain so concurrent calls
 *     within the same instance cannot interleave writes.
 *
 * @module global-chat/mute-store
 */

import { readFile } from 'node:fs/promises';
import { atomicWriteFileAsync } from '../utils/atomic-write.js';
import { getGlobalChatMutesPath } from '../paths.global-chat.js';
import type { MutedIdentity, MuteStore } from './client-types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MuteStoreOptions {
  /** Override the default mutes file path (for tests). */
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidEntry(v: unknown): v is MutedIdentity {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['pubkey'] === 'string' && /^[0-9a-f]{64}$/.test(e['pubkey']) &&
    typeof e['name'] === 'string' && e['name'].length > 0
  );
}

function isValidList(v: unknown): v is MutedIdentity[] {
  return Array.isArray(v) && v.every(isValidEntry);
}

// ---------------------------------------------------------------------------
// FileMuteStore
// ---------------------------------------------------------------------------

export class FileMuteStore implements MuteStore {
  readonly #filePath: string;
  /** Serializes all mutations so within-instance writes never interleave. */
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: MuteStoreOptions = {}) {
    this.#filePath = opts.filePath ?? getGlobalChatMutesPath();
  }

  // -------------------------------------------------------------------------
  // Internal: read the current list; returns [] on any failure
  // -------------------------------------------------------------------------

  async #readList(): Promise<MutedIdentity[]> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Unreadable — treat as empty; do not throw.
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!isValidList(parsed)) return [];
    return parsed;
  }

  // -------------------------------------------------------------------------
  // Internal: write helper
  // -------------------------------------------------------------------------

  async #write(list: MutedIdentity[]): Promise<void> {
    await atomicWriteFileAsync(
      this.#filePath,
      JSON.stringify(list),
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

  async list(): Promise<MutedIdentity[]> {
    return this.#readList();
  }

  async has(pubkey: string): Promise<boolean> {
    const list = await this.#readList();
    return list.some(e => e.pubkey === pubkey);
  }

  async add(pubkey: string, name: string): Promise<void> {
    return this.#enqueue(async () => {
      const list = await this.#readList();
      if (list.some(e => e.pubkey === pubkey)) return;
      await this.#write([...list, { pubkey, name }]);
    });
  }

  async remove(pubkey: string): Promise<void> {
    return this.#enqueue(async () => {
      const list = await this.#readList();
      const next = list.filter(e => e.pubkey !== pubkey);
      if (next.length === list.length) return;
      await this.#write(next);
    });
  }
}
