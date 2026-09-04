/**
 * Task lifecycle state machine for durable task execution.
 *
 * Defines the state machine, retry policy, and TaskRecord shape used by the
 * lease-based recovery system. The default policy (maxAttempts: 1) preserves
 * the existing behaviour: lease → run → complete (success/failure) with no
 * retries — exactly like the prior delete-on-dequeue model, but with a durable
 * lease file instead of an irreversible unlink.
 *
 * @module agent/daemon/task-lifecycle
 */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for a durable task.
 *
 *   queued               → task file sits in queue dir, not yet dequeued
 *   leased               → task is being processed; lease file in leased/ dir
 *   running              → alias for leased (sub-state; not persisted separately)
 *   waiting_human_input  → task is leased but blocked on a human elicitation;
 *                          lease expiry checks are suppressed in this state so
 *                          the task is not incorrectly recovered while a human
 *                          is being asked a question (wired in lease-store.ts
 *                          recoverExpiredLeases and handoff-wiring.ts)
 *   succeeded            → task completed successfully; file moved to completed/
 *   failed               → task failed and maxAttempts reached; moved to completed/
 *   retrying             → task failed but attempts < maxAttempts; re-enqueued
 *   dead-letter          → task exhausted retries; moved to dead-letter/
 */
export type TaskState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'waiting_human_input'
  | 'succeeded'
  | 'failed'
  | 'retrying'
  | 'dead-letter';

// ---------------------------------------------------------------------------
// TaskRecord
// ---------------------------------------------------------------------------

/**
 * Durable per-task record persisted alongside the queue file.
 *
 * Invariant: `id` matches the QueuedTask.id it was derived from.
 * `meta` preserves the original QueuedTask fields for replay/audit.
 */
export interface TaskRecord {
  /** Unique task identifier, matches QueuedTask.id. */
  id: string;
  /** The command string as enqueued. */
  command: string;
  /** Current lifecycle state. */
  state: TaskState;
  /** Number of execution attempts so far (starts at 0, incremented on lease). */
  attempts: number;
  /**
   * Maximum execution attempts before dead-lettering.
   * Default: 1 — preserves the current no-retry behaviour.
   */
  maxAttempts: number;
  /**
   * Epoch ms when the current lease expires. Present only in state 'leased'.
   * A leased task whose leaseExpiry < Date.now() is eligible for recovery.
   */
  leaseExpiry?: number;
  /** Error message from the last failed attempt (if any). */
  lastError?: string;
  /** Epoch ms when this record was first created. */
  createdAt: number;
  /** Epoch ms when this record was last mutated. */
  updatedAt: number;
  /** Backoff strategy applied between retry attempts. */
  backoffStrategy?: 'fixed' | 'exponential';
  /**
   * Base delay in ms for the backoff strategy.
   * For 'fixed': always wait backoffBaseMs.
   * For 'exponential': wait backoffBaseMs * 2^(attempts-1).
   * Default: 30_000.
   */
  backoffBaseMs?: number;
  /**
   * Original QueuedTask fields and any caller-supplied metadata.
   * Preserved verbatim for audit and replay purposes.
   */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RetryPolicy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  maxAttempts: number;
  backoffStrategy: 'fixed' | 'exponential';
  backoffBaseMs: number;
  /**
   * Hard ceiling on the computed backoff delay in ms.
   * Prevents unbounded growth on exponential strategies at high attempt counts.
   * Defaults to DEFAULT_MAX_BACKOFF_MS (5 minutes) when omitted.
   */
  maxBackoffMs?: number;
}

/**
 * Default retry policy: single attempt, no retry.
 * Matches the pre-durable-lifecycle behaviour exactly.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 1,
  backoffStrategy: 'fixed',
  backoffBaseMs: 30_000,
};

/**
 * Maximum backoff delay: 5 minutes.
 * Applied as a hard ceiling in computeBackoffMs when policy.maxBackoffMs is
 * not explicitly set. Prevents exponential strategies from producing
 * multi-hour delays at high attempt counts (e.g. attempts=20 with
 * backoffBaseMs=1000 would otherwise compute ~145 hours).
 */
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1_000; // 5 minutes

// ---------------------------------------------------------------------------
// Lease TTL
// ---------------------------------------------------------------------------

/**
 * Default lease TTL: 10 minutes.
 * Overridable via AFK_LEASE_TTL_MS env var (read in lease-store.ts).
 */
export const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1_000; // 10 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the next backoff delay in ms for a given attempt count and policy.
 *
 * @param attempts - Number of attempts already made (1-based after first fail).
 * @param policy   - RetryPolicy governing the backoff.
 * @returns Delay in ms, capped at policy.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS.
 */
export function computeBackoffMs(attempts: number, policy: RetryPolicy): number {
  const cap = policy.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  if (policy.backoffStrategy === 'exponential') {
    return Math.min(policy.backoffBaseMs * Math.pow(2, Math.max(0, attempts - 1)), cap);
  }
  return Math.min(policy.backoffBaseMs, cap);
}
