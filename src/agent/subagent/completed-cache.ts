/**
 * Bounded LRU cache of recently-completed subagent handles.
 *
 * When a subagent terminates, the parent's `SubagentManager` evicts it
 * from the live `active` map. This cache retains the handle reference so
 * the `/tasks:view` command can access `handle.session.getHistory()`
 * without touching disk — a memory-first fast path before falling back
 * to the JSONL log written by `SubagentLogWriter`.
 *
 * Entries are evicted LRU-first when the cache exceeds capacity.
 *
 * @module agent/subagent/completed-cache
 */

import type { SubagentHandle } from './handle.js';
import type { SubagentResult } from './result.js';

export interface CompletedEntry<T = unknown> {
  readonly handle: SubagentHandle<T>;
  /** Minimal result stub — only `id` and `status` are populated at eviction
   *  time. Narrowed from `SubagentResult<T>` to prevent callers from accessing
   *  fields that were never set. */
  readonly result: Pick<SubagentResult, 'id' | 'status'>;
  readonly completedAt: number;
}

const DEFAULT_CAPACITY = 30;

export class CompletedCache {
  private readonly entries = new Map<string, CompletedEntry>();
  private readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  /** Record a completed subagent. Evicts oldest entry when over capacity. */
  add(id: string, handle: SubagentHandle, result: Pick<SubagentResult, 'id' | 'status'>): void {
    // Delete first so re-insertion moves to end (Map iteration order = insertion order)
    this.entries.delete(id);
    this.entries.set(id, { handle, result, completedAt: Date.now() });
    this.evictIfNeeded();
  }

  /** Retrieve a completed subagent by id. Returns undefined if evicted or unknown. */
  get(id: string): CompletedEntry | undefined {
    return this.entries.get(id);
  }

  /** List all completed entries, newest first. */
  list(): readonly CompletedEntry[] {
    return [...this.entries.values()].reverse();
  }

  /** Number of entries in the cache. */
  get size(): number {
    return this.entries.size;
  }

  /** Remove a specific entry. */
  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Remove all entries. */
  clear(): void {
    this.entries.clear();
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.capacity) {
      // Map.keys() yields in insertion order — first key is oldest
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
      else break;
    }
  }
}
