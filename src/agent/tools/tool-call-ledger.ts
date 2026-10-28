/**
 * Session-scoped ToolCallLedger — a bounded Map of every tool invocation and
 * its settled result, keyed by `toolName + inputHash`, indexed by turn.
 *
 * The ledger is the foundation for three consumer patterns (issue #4476):
 *
 *   1. **Repeat-failure suppression** — before executing, check whether the
 *      same call has already failed within the last N turns; if so, skip it
 *      and surface the prior failure with a structured hint.
 *   2. **Pre-flight resource gate** — before dispatching, consult a small
 *      registry of pre-conditions keyed by tool family.
 *   3. **Observability** — the ledger IS the telemetry; callers can walk it
 *      without touching the witness channel.
 *
 * This file delivers the first acceptance criterion: the data structure itself.
 * Wiring at the dispatch boundary and the two active consumers (suppression,
 * gate) are left to follow-on PRs, as documented in issue #4476.
 *
 * ## Design invariants
 *
 * - **Session-scoped, not turn-scoped.** A `RepeatFailureGuard` lives only for
 *   one turn (it is reconstructed per dispatcher). The ledger intentionally
 *   spans the whole session so future consumers can look back across turns to
 *   detect inter-turn retry spirals — the failure class the 2026-10-26 audit
 *   identified as uncaptured.
 *
 * - **Bounded by a configurable turn window.** `prune(currentTurn)` removes
 *   entries whose most-recent observation is more than `turnWindow` turns old.
 *   Callers are responsible for calling `prune` periodically (e.g. once per
 *   dispatcher batch). This keeps memory usage proportional to `turnWindow ×
 *   average distinct calls per turn`, never the session length.
 *
 * - **Append-only per key within a window.** Multiple results for the same
 *   (toolName, inputHash) pair accumulate in arrival order so `lookup` can
 *   return a full history: failure → transient success → failure is a
 *   different signal than three straight failures.
 *
 * - **Pure data — no side effects.** The ledger never emits trace events,
 *   never mutates tool results, and never blocks execution. It is a passive
 *   store; judgment belongs in consumers.
 *
 * ## Key derivation
 *
 * The composite key is `toolName + "\x00" + inputHash`. `inputHash` is
 * expected to come from `fingerprintToolCall` in `suspected-loop-detector.ts`
 * (sha256 over `name\0canonicalJSON(input)`), but the ledger treats it as an
 * opaque string — callers own the hashing policy.
 *
 * Invariant: pure data store — no side effects, no trace emissions, no result
 * mutations. All judgment belongs in consumers; the ledger only records and
 * returns.
 *
 * @module agent/tools/tool-call-ledger
 */

import type { ToolResult } from '../providers/anthropic-direct/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default turn window: entries older than this many turns (measured from the
 * most recent observation of a given key) are eligible for pruning.
 *
 * 20 is large enough to catch inter-turn retry spirals across a realistic
 * agent execution (a few minutes of wall time) while keeping memory bounded.
 * Match `SUSPECTED_LOOP_WINDOW_SIZE` from suspected-loop-detector for
 * consistency; the two values may diverge if the ledger is tuned separately.
 */
export const DEFAULT_TURN_WINDOW = 20;

/**
 * Hard cap on the number of distinct (toolName, inputHash) keys the ledger
 * will hold at any time. Once reached, `record()` is a no-op for new keys
 * until a `prune()` call frees space. Existing keys are always updated.
 *
 * Prevents unbounded growth in adversarial sessions where every call has a
 * unique input — degenerate cases (e.g. a `bash` call with a unique timestamp
 * argument each time) would otherwise fill heap proportional to session length.
 */
export const MAX_LEDGER_KEYS = 2_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single recorded observation: the settled result plus the turn index at
 * which it was recorded. Turn indices are caller-supplied unsigned integers;
 * the ledger treats them as opaque ordinals (only `>=` comparisons are used).
 */
export interface LedgerEntry {
  /** The settled tool result (may be a success or an error). */
  readonly result: ToolResult;
  /** Turn index at which this observation was recorded. */
  readonly turnIndex: number;
}

/**
 * The full per-key history: all observations for a given (toolName, inputHash)
 * pair within the current turn window, in recording order (oldest first).
 */
export type LedgerHistory = readonly LedgerEntry[];

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Mutable per-key bucket held inside the Map. */
interface Bucket {
  /** Ordered list of observations, oldest first. */
  entries: LedgerEntry[];
  /** Turn index of the most-recently recorded entry — used by `prune`. */
  latestTurn: number;
}

// ---------------------------------------------------------------------------
// ToolCallLedger
// ---------------------------------------------------------------------------

/**
 * Session-scoped ledger of tool call observations, keyed by
 * `toolName + "\x00" + inputHash` and bounded by a configurable turn window.
 *
 * Typical lifecycle:
 *   1. Instantiate once per session (or per dispatcher, if finer scoping is
 *      wanted) and thread through to every dispatch site.
 *   2. Call `record(toolName, inputHash, result, turnIndex)` after every
 *      settled tool result.
 *   3. Call `lookup(toolName, inputHash, currentTurn)` before dispatching to
 *      retrieve prior observations within the window.
 *   4. Call `prune(currentTurn)` periodically to release old entries.
 */
export class ToolCallLedger {
  private readonly buckets = new Map<string, Bucket>();
  private readonly turnWindow: number;

  /**
   * @param turnWindow  Number of turns to retain observations. Entries whose
   *                    most-recent observation is older than `currentTurn -
   *                    turnWindow` are removed by `prune()`.
   *                    Defaults to {@link DEFAULT_TURN_WINDOW}.
   */
  constructor(turnWindow: number = DEFAULT_TURN_WINDOW) {
    if (!Number.isInteger(turnWindow) || turnWindow < 1) {
      throw new RangeError(
        `ToolCallLedger: turnWindow must be a positive integer, got ${turnWindow}`,
      );
    }
    this.turnWindow = turnWindow;
  }

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Record a settled tool result.
   *
   * Appends `{ result, turnIndex }` to the bucket for
   * `toolName + "\x00" + inputHash`. If the key is new and the ledger is at
   * {@link MAX_LEDGER_KEYS}, the call is silently dropped — existing keys are
   * always updated regardless of the cap.
   *
   * @param toolName   The tool's registered name (e.g. `"bash"`).
   * @param inputHash  Caller-computed hash of the normalized input.
   * @param result     The fully-settled `ToolResult`.
   * @param turnIndex  Non-negative integer turn counter from the session.
   */
  record(toolName: string, inputHash: string, result: ToolResult, turnIndex: number): void {
    const key = compositeKey(toolName, inputHash);
    let bucket = this.buckets.get(key);

    if (bucket === undefined) {
      // Enforce key cap for new keys only — never drop updates to existing keys.
      if (this.buckets.size >= MAX_LEDGER_KEYS) return;
      bucket = { entries: [], latestTurn: turnIndex };
      this.buckets.set(key, bucket);
    }

    bucket.entries.push({ result, turnIndex });
    if (turnIndex > bucket.latestTurn) {
      bucket.latestTurn = turnIndex;
    }
  }

  /**
   * Retrieve all observations for `(toolName, inputHash)` within the current
   * turn window.
   *
   * Returns entries whose `turnIndex >= currentTurn - turnWindow`. The result
   * is in recording order (oldest first) and is an empty array when no
   * matching observations exist or all are outside the window.
   *
   * The returned array is a read-only snapshot — mutations to the ledger after
   * this call do not affect previously returned arrays.
   *
   * @param toolName    The tool name to look up.
   * @param inputHash   The normalized input hash to look up.
   * @param currentTurn The caller's current turn index (used to compute the
   *                    window boundary `currentTurn - turnWindow`).
   */
  lookup(toolName: string, inputHash: string, currentTurn: number): LedgerHistory {
    const bucket = this.buckets.get(compositeKey(toolName, inputHash));
    if (bucket === undefined) return [];
    const cutoff = currentTurn - this.turnWindow;
    return bucket.entries.filter((e) => e.turnIndex >= cutoff);
  }

  /**
   * Remove buckets that are entirely outside the turn window as of
   * `currentTurn`. A bucket is prunable when its `latestTurn < currentTurn -
   * turnWindow` — i.e. every entry in it is stale.
   *
   * Call once per turn (or once per dispatcher batch) to keep memory bounded.
   * Pruning is O(n) in the number of distinct keys, not in the total number of
   * observations.
   *
   * @param currentTurn The caller's current turn index.
   */
  prune(currentTurn: number): void {
    const cutoff = currentTurn - this.turnWindow;
    for (const [key, bucket] of this.buckets) {
      if (bucket.latestTurn < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics (tests and observability consumers)
  // -------------------------------------------------------------------------

  /** Total number of distinct (toolName, inputHash) keys currently held. */
  get keyCount(): number {
    return this.buckets.size;
  }

  /** Total number of individual observations across all keys. */
  get entryCount(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      total += bucket.entries.length;
    }
    return total;
  }

  /**
   * Returns the number of observations for a given key (within OR outside the
   * window). Useful for tests that want to verify no data is silently dropped
   * before a prune call.
   *
   * @internal Exposed for testing; not part of the stable consumer API.
   */
  rawEntryCountFor(toolName: string, inputHash: string): number {
    return this.buckets.get(compositeKey(toolName, inputHash))?.entries.length ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the Map key from `(toolName, inputHash)`.
 *
 * The null-byte separator is the same delimiter used by `fingerprintToolCall`
 * when it hashes `name + "\x00" + canonicalJSON(input)` — keeping the two
 * key schemes structurally parallel makes it easier to pass the hash directly
 * from the fingerprint function without further transformation.
 */
function compositeKey(toolName: string, inputHash: string): string {
  return `${toolName}\x00${inputHash}`;
}
