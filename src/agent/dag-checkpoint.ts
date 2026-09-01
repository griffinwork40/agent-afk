/**
 * DAG execution checkpointing.
 *
 * Saves a durable checkpoint after each layer of a DAG completes. On restart
 * the executor loads the checkpoint, verifies the DAG hash, and skips already-
 * completed nodes — enabling crash recovery without re-running expensive work.
 *
 * Checkpoint location: `~/.afk/state/dag-checkpoints/<dagId>.json`
 *
 * Hash invariant: the dagHash is a SHA-256 of the canonicalised node IDs and
 * edges. A structure change (new node, removed edge, reordered nodes) produces
 * a different hash, causing `loadCheckpoint` to reject the stale file and
 * return null — forcing a clean re-run.
 *
 * Node outputs are truncated to 10 KB each to bound checkpoint file size;
 * the full output is NOT persisted (callers that need it must re-run the node).
 *
 * @module agent/dag-checkpoint
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAfkStateDir } from '../paths.js';

/** Root directory for DAG checkpoints under the AFK state tier. */
function dagCheckpointsDir(): string { return join(getAfkStateDir(), 'dag-checkpoints'); }

/** dagId charset guard — mirrors isSafeLedgerSessionId in paths.ts. */
const DAG_ID_SAFE = /^[A-Za-z0-9_-]+$/;
function checkpointPath(dagId: string): string | null {
  if (!dagId || !DAG_ID_SAFE.test(dagId) || dagId.length > 128) return null;
  return join(dagCheckpointsDir(), `${dagId}.json`);
}
import type { DAGGraph } from './dag.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Maximum bytes stored per node output to bound checkpoint file size. */
const MAX_OUTPUT_BYTES_PER_NODE = 10 * 1024; // 10 KB

export interface DAGCheckpoint {
  /** SHA-256 of the canonical DAG definition (node IDs sorted + edge pairs sorted). */
  dagHash: string;
  /** Node IDs that completed successfully before the checkpoint was saved. */
  completedNodes: string[];
  /**
   * Per-node outputs, truncated to {@link MAX_OUTPUT_BYTES_PER_NODE} each.
   * Only string-serialisable outputs are stored; non-string values are JSON-encoded.
   */
  nodeOutputs: Record<string, string>;
  /** Node IDs that failed in the checkpointed run. */
  failedNodes: string[];
  /**
   * Original error messages for failed nodes.
   * Populated by saveCheckpoint so restored runs surface the original error
   * rather than the generic 'restored from checkpoint' fallback.
   */
  nodeErrors?: Record<string, string>;
  /** Node IDs that were skipped (due to upstream failure + failFast). */
  skippedNodes: string[];
  /** Epoch ms when this checkpoint was written. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 of the DAG graph structure.
 *
 * The hash covers:
 *   - Node IDs sorted lexicographically
 *   - Edges as "from->to" pairs, sorted lexicographically
 *
 * Node `run` functions are intentionally excluded — they may be closures that
 * differ across processes even for the same logical task. The hash is a
 * structural identity check, not a code-equality check.
 */
export function computeDAGHash(graph: DAGGraph): string {
  const nodeIds = [...graph.nodes.map((n) => n.id)].sort();
  const edgePairs = [...graph.edges.map((e) => `${e.from}->${e.to}`)].sort();
  const canonical = JSON.stringify({ nodes: nodeIds, edges: edgePairs });
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Checkpoint I/O
// ---------------------------------------------------------------------------

/**
 * Persist a DAG checkpoint atomically to disk.
 *
 * @param dagId      - Caller-supplied DAG identifier (must be safe for filesystem paths).
 * @param checkpoint - Checkpoint state to persist.
 */
export async function saveCheckpoint(
  dagId: string,
  checkpoint: DAGCheckpoint,
): Promise<void> {
  mkdirSync(dagCheckpointsDir(), { recursive: true });
  const dest = checkpointPath(dagId);
  if (dest === null) throw new Error(`Invalid dagId: ${JSON.stringify(dagId)}`);
  const tmp = join(dirname(dest), `.tmp-${randomBytes(4).toString('hex')}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(checkpoint), 'utf-8');
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Load a checkpoint for the given DAG, verifying the hash matches.
 *
 * Returns null when:
 *   - No checkpoint file exists (cold start)
 *   - The file cannot be parsed (corrupt)
 *   - The stored dagHash does not match `expectedHash` (stale/incompatible DAG)
 *
 * @param dagId        - DAG identifier.
 * @param expectedHash - Hash computed from the current DAG definition.
 */
export async function loadCheckpoint(
  dagId: string,
  expectedHash: string,
): Promise<DAGCheckpoint | null> {
  const path = checkpointPath(dagId);
  if (path === null) return null; // Invalid dagId.
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  let checkpoint: DAGCheckpoint;
  try {
    checkpoint = JSON.parse(raw) as DAGCheckpoint;
  } catch {
    return null; // Corrupt file.
  }
  if (checkpoint.dagHash !== expectedHash) {
    return null; // Stale checkpoint — DAG structure changed.
  }
  return checkpoint;
}

/**
 * Remove the checkpoint file for a DAG (called on successful completion).
 *
 * No-op if the file does not exist.
 *
 * @param dagId - DAG identifier.
 */
export async function clearCheckpoint(dagId: string): Promise<void> {
  const path = checkpointPath(dagId);
  if (path === null) return; // Invalid dagId — nothing to clear.
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch { /* ignore — best-effort */ }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a node output value to a truncated string for checkpoint storage.
 *
 * Strings are used as-is (then truncated); other values are JSON-encoded.
 * `undefined` (JSON.stringify returns undefined, not a string) is stored as ''.
 * Truncation uses Buffer.byteLength so the constant MAX_OUTPUT_BYTES_PER_NODE
 * is honoured as a true byte limit (UTF-8), not a UTF-16 code-unit count.
 *
 * Multi-byte code points at the cut boundary are handled by converting back to
 * a string (which may replace incomplete sequences with U+FFFD), then trimming
 * the result down until its UTF-8 byte count is within the limit.
 */
export function serializeOutput(value: unknown): string {
  // JSON.stringify(undefined) returns undefined (not a string), so handle explicitly.
  if (value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  if (Buffer.byteLength(str, 'utf8') <= MAX_OUTPUT_BYTES_PER_NODE) return str;
  // Slice at the byte boundary. Buffer.toString may introduce a U+FFFD replacement
  // character (3 bytes) for a cut multi-byte sequence, so trim until we fit.
  let result = Buffer.from(str).subarray(0, MAX_OUTPUT_BYTES_PER_NODE).toString('utf8');
  while (Buffer.byteLength(result, 'utf8') > MAX_OUTPUT_BYTES_PER_NODE) {
    result = result.slice(0, -1);
  }
  return result;
}
