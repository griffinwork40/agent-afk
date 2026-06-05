/**
 * CommitCoordinator — serializes all scrollback writes with declared anchors.
 *
 * Addresses Bug #1: the `void finalizeOrchestrator(...)` fire-and-forget
 * caused markdown.flush() to race with synchronous tool-lane flushes.
 *
 * Design:
 *   - `schedule()` is **synchronous** and side-effect-free (only mutates the
 *     internal queue). Callers never need to `await` it.
 *   - `flushAll()` is **async** and drains all queued batches in fixed anchor
 *     order. It is called once at turn end from `StreamRenderer.dispose()`.
 *
 * Drain order:
 *   1. all `'before-content'` batches  — sync commits that precede markdown
 *   2. `await streamingMarkdownFlush()` — injected markdown flush dependency
 *   3. all `'after-subagent:${id}'` batches in registration order
 *   4. all `'after-content'` batches
 *
 * Constraint (pattern card: agents-fail-ordered-operations-when-constraint-is-externally-governed):
 * The drain order is the externally-governed invariant for Bug #1. It is
 * documented here and tested directly in commit-coordinator.test.ts.
 *
 * @module cli/_lib/commit-coordinator
 */

/**
 * Ordering anchor that declares where in the turn's scrollback a batch belongs.
 *
 * - `'before-content'`       — before the streaming-markdown content flush
 *   (e.g. orchestrator tool-lane entries and the thinking summary — per-phase
 *   inline on TTY, cumulative on non-TTY — that preceded prose generation)
 * - `'after-subagent:${id}'` — after markdown, grouped by subagent identity
 *   (e.g. subagent done-result block with its parent synthetic-agent entry)
 * - `'after-content'`        — after all subagent blocks
 *   (e.g. skill badges, emitted panels)
 */
export type CommitAnchor =
  | 'before-content'
  | 'after-content'
  | `after-subagent:${string}`;

/**
 * A unit of deferred scrollback work. Each commit closure performs one
 * `commitAbove(line)` call (or several), captured at schedule-time and
 * executed only when `flushAll()` drains this anchor.
 */
export interface CommitBatch {
  anchor: CommitAnchor;
  /** Each closure performs one or more synchronous `commitAbove` calls. */
  commits: Array<() => void>;
}

/**
 * Single ordering authority for scrollback writes during a turn.
 *
 * One instance per `StreamRenderer` turn. Lifetime is per-turn — no reset
 * needed. Construction sites:
 *   - `turn-handler.ts:76`
 *   - `builtin-skills.ts:36`
 *   - `init.ts:80`
 * All are per-invocation; each new `StreamRenderer` owns a fresh
 * `CommitCoordinator`.
 */
export class CommitCoordinator {
  // Internal storage: three arrays + a Map for ordered after-subagent:* draining.
  //
  // External constraint governing the sequence: Bug #1 ordering invariant —
  // markdown content (step 2) must precede subagent result blocks (step 3).
  // The four-step drain order below is the enforcement mechanism. Do NOT
  // reorder without updating commit-coordinator.test.ts first.
  private readonly beforeContent: CommitBatch[] = [];
  private readonly afterSubagent: Map<string, CommitBatch[]> = new Map();
  private readonly afterContent: CommitBatch[] = [];

  /**
   * Register a batch in the internal queue keyed by anchor.
   *
   * **Synchronous and side-effect-free.** Does not call `commitAbove`, does
   * not perform I/O, does not `await` anything. Safe to call from any
   * synchronous event handler.
   */
  schedule(batch: CommitBatch): void {
    const { anchor } = batch;
    if (anchor === 'before-content') {
      this.beforeContent.push(batch);
    } else if (anchor === 'after-content') {
      this.afterContent.push(batch);
    } else {
      // `after-subagent:${id}` — extract the id and store in insertion-order map.
      const id = anchor.slice('after-subagent:'.length);
      let list = this.afterSubagent.get(id);
      if (!list) {
        list = [];
        this.afterSubagent.set(id, list);
      }
      list.push(batch);
    }
  }

  /**
   * Drain all queued batches in fixed anchor order. Idempotent — calling
   * twice is safe (second call drains empty queues, no-op).
   *
   * Drain order (externally governed — see file-level doc):
   *   1. `'before-content'` batches (sync commit closures)
   *   2. `await streamingMarkdownFlush()` — pass the markdown flush as a
   *      parameter; `undefined` is a no-op (no markdown renderer active)
   *   3. `'after-subagent:*'` batches in registration order
   *   4. `'after-content'` batches
   *
   * @param streamingMarkdownFlush — optional async function that flushes the
   *   orchestrator's `StreamingMarkdownRenderer`. Passed in by
   *   `StreamRenderer.dispose()` so CommitCoordinator does not hold a direct
   *   reference to the markdown renderer (cleaner dependency injection).
   */
  /**
   * Eagerly drain a single `after-subagent:${id}` batch — called on the
   * subagent done-event path when no orchestrator markdown is pending.
   *
   * Drain order mirrors steps 1 + 3 of {@link flushAll}:
   *   1. all `'before-content'` batches  (sync — orchestrator tool-lane entries)
   *   2. the targeted `after-subagent:${id}` batch
   *
   * The batch is deleted from the map after execution so {@link flushAll}
   * cannot re-fire it (belt-and-suspenders against double-commit).
   *
   * Callers gate on `!streamingMarkdownRef.current` — when orchestrator
   * markdown exists, the Bug #1 ordering invariant requires the markdown
   * flush (step 2 of flushAll) to run first, so the caller falls back to
   * deferred drain via flushAll at dispose-time.
   */
  drainSubagent(id: string): void {
    // Step 1: drain before-content (same as flushAll step 1).
    for (const batch of this.beforeContent.splice(0)) {
      for (const commit of batch.commits) {
        commit();
      }
    }

    // Step 2: drain the targeted after-subagent batch.
    const batches = this.afterSubagent.get(id);
    if (batches) {
      this.afterSubagent.delete(id);
      for (const batch of batches) {
        for (const commit of batch.commits) {
          commit();
        }
      }
    }
  }

  async flushAll(streamingMarkdownFlush?: () => Promise<void>): Promise<void> {
    // Step 1: before-content (synchronous commits that precede markdown)
    for (const batch of this.beforeContent.splice(0)) {
      for (const commit of batch.commits) {
        commit();
      }
    }

    // Step 2: streaming markdown flush (async — this is the externally-governed
    // ordering boundary for Bug #1)
    if (streamingMarkdownFlush) {
      try {
        await streamingMarkdownFlush();
      } catch {
        /* best effort — mirrors the existing pattern in StreamRenderer.dispose() */
      }
    }

    // Step 3: after-subagent batches in registration (insertion) order.
    //
    // External constraint: insertion order must be preserved (Bug #1 ordering
    // invariant). Snapshot-then-delete-per-entry: take a point-in-time
    // snapshot of the map entries via Array.from(), then delete each key as
    // we execute its batches. Any new after-subagent entry scheduled during
    // the awaited markdown flush above, or by a commit closure below, lands
    // in the live map under a fresh key and is NOT in the snapshot — it
    // will be picked up by the next flushAll() call rather than silently
    // dropped by a bulk .clear() after iteration. Symmetric with the
    // splice(0) drain used for beforeContent/afterContent.
    for (const [id, batches] of Array.from(this.afterSubagent)) {
      this.afterSubagent.delete(id);
      for (const batch of batches) {
        for (const commit of batch.commits) {
          commit();
        }
      }
    }

    // Step 4: after-content batches
    for (const batch of this.afterContent.splice(0)) {
      for (const commit of batch.commits) {
        commit();
      }
    }
  }
}
