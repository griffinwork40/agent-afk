/**
 * Durable NDJSON storage for effect records.
 *
 * File layout: `$AFK_STATE_DIR/effect-ledger.jsonl` — one JSON object per
 * line, append-only (new records) + full-rewrite on status updates (rare).
 *
 * Design decisions:
 *   - Append for new records: O(1) write, no in-memory state required.
 *   - Read+filter for queries: linear scan — acceptable for v1 with a
 *     bounded ledger size. SQLite is the designated v2 upgrade path.
 *   - Status update writes the full record to a new line; queries return
 *     the last record with a given id (fold/last-write-wins semantics).
 *     This avoids rewriting the file on every update at the cost of
 *     duplicate ids in the log — reconcilable on compaction.
 *   - Disk errors on write are caught and surface only via the returned
 *     error; callers decide whether to propagate or absorb.
 *   - mkdir is called lazily on first write; read handles ENOENT gracefully.
 *
 * @module agent/effect-ledger/store
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getEffectLedgerPath } from '../../paths.js';
import type {
  EffectRecord,
  EffectQuery,
  PendingEffectInput,
  ExecuteEffectInput,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Write one JSONL line. Creates parent dir on first call. */
function appendLine(path: string, record: EffectRecord): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/** Parse a JSONL file, skipping malformed lines. Returns all valid records. */
async function readAllRecords(path: string): Promise<EffectRecord[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const records: EffectRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isEffectRecord(parsed)) records.push(parsed);
    } catch {
      // Skip malformed lines — partial writes, truncated lines, format drift.
    }
  }
  return records;
}

/** Minimal runtime shape-check (not a full schema validator). */
function isEffectRecord(v: unknown): v is EffectRecord {
  return (
    v !== null &&
    typeof v === 'object' &&
    (v as Record<string, unknown>)['v'] === 1 &&
    typeof (v as Record<string, unknown>)['id'] === 'string' &&
    typeof (v as Record<string, unknown>)['idempotencyKey'] === 'string' &&
    typeof (v as Record<string, unknown>)['operationType'] === 'string' &&
    typeof (v as Record<string, unknown>)['status'] === 'string' &&
    typeof (v as Record<string, unknown>)['timestamp'] === 'number'
  );
}

/**
 * Collapse duplicate ids: for each id, keep only the last record. This is
 * the fold / last-write-wins policy that lets status updates be appends.
 */
function collapseById(records: EffectRecord[]): EffectRecord[] {
  const byId = new Map<string, EffectRecord>();
  for (const r of records) {
    byId.set(r.id, r);
  }
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// EffectStore
// ---------------------------------------------------------------------------

/**
 * Durable NDJSON store for {@link EffectRecord}s.
 *
 * Instantiate once per process (or once per test) and share. All methods are
 * synchronous on the write path (appendFileSync) to stay off the critical path
 * for tool execution. Reads are async (readFile).
 */
export class EffectStore {
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? getEffectLedgerPath();
  }

  // ---------------------------------------------------------------------------
  // Write-ahead: create pending record
  // ---------------------------------------------------------------------------

  /**
   * Write a "pending" record to the ledger BEFORE execution begins.
   *
   * Returns the created record (including its generated `id`). Throws if the
   * write fails — callers should decide whether to propagate or absorb.
   *
   * Does NOT deduplicate here; the dedup check belongs in the hook layer so it
   * can gate execution, not just logging.
   */
  writePending(input: PendingEffectInput): EffectRecord {
    const record: EffectRecord = {
      v: 1,
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      operationType: input.operationType,
      args: input.args,
      status: 'pending',
      sessionId: input.sessionId,
      taskId: input.taskId,
      timestamp: Date.now(),
    };
    appendLine(this.path, record);
    return record;
  }

  // ---------------------------------------------------------------------------
  // Post-execution: transition status
  // ---------------------------------------------------------------------------

  /**
   * Update a record's status after execution completes.
   *
   * Implementation: appends a new line with the updated record (last-write-wins
   * on query). This avoids a file rewrite on every status transition.
   *
   * Throws if the record does not exist or if the write fails.
   */
  async updateStatus(input: ExecuteEffectInput): Promise<EffectRecord> {
    const all = await readAllRecords(this.path);
    const collapsed = collapseById(all);
    const existing = collapsed.find((r) => r.id === input.id);
    if (!existing) {
      throw new Error(`effect-ledger: record not found: ${input.id}`);
    }
    const updated: EffectRecord = {
      ...existing,
      status: input.status,
      result: input.result,
      ...(input.status === 'confirmed' || input.status === 'ambiguous'
        ? { reconciledAt: Date.now() }
        : {}),
    };
    appendLine(this.path, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Dedup check
  // ---------------------------------------------------------------------------

  /**
   * Look up a record by idempotency key. Returns the record if found (after
   * last-write-wins collapse), or `null` if not found.
   *
   * Used by the hook to detect whether an operation was already started so
   * duplicate execution can be skipped.
   */
  async findByIdempotencyKey(key: string): Promise<EffectRecord | null> {
    const all = await readAllRecords(this.path);
    const collapsed = collapseById(all);
    return collapsed.find((r) => r.idempotencyKey === key) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Query API
  // ---------------------------------------------------------------------------

  /**
   * Query the ledger with optional filters. All provided filter fields are
   * ANDed. Returns records in write order (oldest first), after id-collapse.
   */
  async query(filters: EffectQuery = {}): Promise<EffectRecord[]> {
    const all = await readAllRecords(this.path);
    const collapsed = collapseById(all);
    return collapsed.filter((r) => {
      if (filters.sessionId !== undefined && r.sessionId !== filters.sessionId) return false;
      if (filters.operationType !== undefined && r.operationType !== filters.operationType)
        return false;
      if (filters.status !== undefined && r.status !== filters.status) return false;
      if (filters.idempotencyKey !== undefined && r.idempotencyKey !== filters.idempotencyKey)
        return false;
      return true;
    });
  }

  /**
   * Return all records, id-collapsed, oldest-first.
   * Convenience alias for `query({})`.
   */
  async all(): Promise<EffectRecord[]> {
    return this.query();
  }
}
