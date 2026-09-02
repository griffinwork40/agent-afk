/**
 * Idempotency key computation for the effect ledger.
 *
 * An idempotency key uniquely identifies an (operation, arguments) pair so the
 * ledger can detect duplicate invocations and skip re-execution. Keys must be:
 *   - **Deterministic**: same inputs always produce the same key.
 *   - **Stable across retries**: key computation must not incorporate any
 *     wall-clock time, random nonce, or per-call UUID.
 *   - **Collision-resistant**: SHA-256 over a canonical serialization.
 *
 * # Canonical serialization
 *
 * JSON.stringify produces non-deterministic key ordering when the input object
 * was assembled from multiple sources. We use a recursive sort-keys approach so
 * `{b:1,a:2}` and `{a:2,b:1}` hash identically. Arrays are NOT reordered —
 * argument order in arrays is semantically significant (e.g. a list of file
 * paths to delete).
 *
 * @module agent/effect-ledger/idempotency
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Stable JSON serialization
// ---------------------------------------------------------------------------

/**
 * Serialize `value` to JSON with recursively sorted object keys.
 * Arrays preserve their element order. Primitive values are passed through.
 */
function stableStringify(value: unknown): string {
  // undefined is not serializable via JSON.stringify (returns undefined, not a
  // string). Normalize to null so the hash function always receives a string.
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]));
  return '{' + pairs.join(',') + '}';
}

// ---------------------------------------------------------------------------
// Key computation
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic idempotency key from an operation type and
 * (optionally) a structured arguments object.
 *
 * The key is a 64-hex-char SHA-256 digest of
 * `<operationType>\0<stableJson(args)>`. Passing `undefined` for `args`
 * produces a key that covers only the operation type — useful for tools that
 * have no meaningful input (e.g. a zero-argument status probe).
 */
export function computeIdempotencyKey(operationType: string, args: unknown): string {
  const h = createHash('sha256');
  h.update(operationType);
  h.update('\0');
  h.update(stableStringify(args));
  return h.digest('hex');
}
