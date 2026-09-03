/**
 * Data-model types for the external-effect ledger.
 *
 * An *effect record* describes one externally-visible side effect — a
 * Telegram send, a GitHub PR creation, a MCP mutation, etc. — from its
 * intent through its observed outcome. The record lifecycle is:
 *
 *   prepare   → write "pending" record (write-ahead, before execution)
 *   execute   → update to "executed" / "failed" / "ambiguous"
 *   reconcile → (future) update to "confirmed" after out-of-band verification
 *
 * @module agent/effect-ledger/types
 */

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/** All possible lifecycle states for an effect record. */
export type EffectStatus =
  /** Written before execution begins (write-ahead). */
  | 'pending'
  /** Execution returned without throwing (outcome not yet confirmed externally). */
  | 'executed'
  /** Independently confirmed to have taken effect (out-of-band check). */
  | 'confirmed'
  /** Execution threw / returned an error result. */
  | 'failed'
  /**
   * Execution succeeded locally but external confirmation is impossible or
   * ambiguous (e.g. network cut after send, no idempotency header support).
   */
  | 'ambiguous';

// ---------------------------------------------------------------------------
// Core record
// ---------------------------------------------------------------------------

/**
 * One durable row in the effect ledger.
 *
 * Stored as NDJSON. `v` is the schema version (always 1 for this release).
 * The `args` and `result` fields are redacted copies — secrets removed before
 * writing to disk.
 */
export interface EffectRecord {
  /** Schema version. */
  v: 1;
  /** UUID v4 unique row identifier. */
  id: string;
  /**
   * Deterministic identifier computed from `operationType + stable-JSON(args)`.
   * A caller may supply their own; the store will never overwrite an existing
   * record with the same key (deduplication gate).
   */
  idempotencyKey: string;
  /**
   * Coarse operation classifier, e.g. `"send_telegram"`, `"gh_pr_create"`,
   * `"mcp_write"`, `"bash_external"`. Populated by the classifier from the
   * tool name and (optionally) the args content.
   */
  operationType: string;
  /** Redacted copy of tool input. Never contains raw secrets. */
  args: unknown;
  /** Current lifecycle status. */
  status: EffectStatus;
  /** Originating session id (may be undefined for out-of-session writes). */
  sessionId?: string;
  /** Caller-supplied task or job identifier for correlation. */
  taskId?: string;
  /** Unix epoch ms when the record was written. */
  timestamp: number;
  /** Redacted summary of the tool output (set on execute). */
  result?: unknown;
  /** Unix epoch ms when a reconcile transition occurred. */
  reconciledAt?: number;
}

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

/** Filters for {@link EffectStore.query}. All fields are ANDed together. */
export interface EffectQuery {
  sessionId?: string;
  operationType?: string;
  status?: EffectStatus;
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Write-ahead / update inputs
// ---------------------------------------------------------------------------

/** Payload for writing a new "pending" record before execution begins. */
export interface PendingEffectInput {
  idempotencyKey: string;
  operationType: string;
  /** Already-redacted args (caller owns redaction). */
  args: unknown;
  sessionId?: string;
  taskId?: string;
}

/** Payload for transitioning a pending record after execution completes. */
export interface ExecuteEffectInput {
  id: string;
  /** Outcome status — never "pending". */
  status: Exclude<EffectStatus, 'pending'>;
  /** Already-redacted result summary (caller owns redaction). */
  result?: unknown;
}
