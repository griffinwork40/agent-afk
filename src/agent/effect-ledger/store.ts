/**
 * Durable NDJSON storage for effect records.
 *
 * File layout: `$AFK_STATE_DIR/effect-ledger.jsonl` — one JSON object per
 * line, append-only (new records and status transitions).
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
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getEffectLedgerPath } from '../../paths.js';
import { collectAsyncIter, readJsonlFile } from '../../utils/jsonl.js';
import { boundedLines, type InputBudget } from '../outcomes/outcomes-input.js';
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
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path, 'a', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + '\n', { encoding: 'utf8' });
    // Invariant: write-ahead intent must be durable before remote dispatch;
    // a buffered append alone can disappear on process or host failure.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse a JSONL file, skipping malformed lines. Returns all valid records. */
async function readAllRecords(path: string): Promise<EffectRecord[]> {
  // readJsonlFile handles ENOENT gracefully (zero records); other I/O errors
  // propagate, preserving the previous throw-on-unexpected-error contract.
  // appendLine uses appendFileSync with mode 0o600 — appendJsonl cannot be
  // used here because it does not support per-file mode bits.
  return collectAsyncIter(readJsonlFile<EffectRecord>(path, { guard: isEffectRecord }));
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
 * synchronous on the write path (append + fsync) so intent is durable
 * before tool execution. Reads are async.
 */
export class EffectStore {
  private readonly path: string;
  /** In-memory cache to avoid O(N) re-reads within the same hook cycle. */
  private cachedRecords: EffectRecord[] | null = null;

  constructor(path?: string) {
    this.path = path ?? getEffectLedgerPath();
  }

  /** Read records, returning the cached copy if still valid. */
  private async readCached(): Promise<EffectRecord[]> {
    if (this.cachedRecords !== null) return this.cachedRecords;
    this.cachedRecords = await readAllRecords(this.path);
    return this.cachedRecords;
  }

  /** Invalidate the cache after a write so the next read sees the new data. */
  private invalidateCache(): void {
    this.cachedRecords = null;
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
      retryOf: input.retryOf,
      timestamp: Date.now(),
    };
    appendLine(this.path, record);
    this.invalidateCache();
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
    const all = await this.readCached();
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
    this.invalidateCache();
    return updated;
  }

  /** Persist the one-time retry warning on the uncertain attempt. */
  async acknowledgeRetry(id: string): Promise<EffectRecord> {
    const existing = collapseById(await this.readCached()).find((r) => r.id === id);
    if (!existing) throw new Error(`effect-ledger: record not found: ${id}`);
    if (existing.retryAcknowledgedAt !== undefined) return existing;
    const updated = { ...existing, retryAcknowledgedAt: Date.now() };
    appendLine(this.path, updated);
    this.invalidateCache();
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Dedup check
  // ---------------------------------------------------------------------------

  /**
   * Look up a record by idempotency key. Returns the record if found (after
   * last-write-wins collapse), or `null` if not found.
   *
   * When `sessionId` is provided, only records from that session are considered
   * so two independent sessions sending the same message are not falsely deduped.
   *
   * Used by the hook to detect whether an operation was already started so
   * duplicate execution can be skipped.
   */
  async findByIdempotencyKey(key: string, sessionId?: string): Promise<EffectRecord | null> {
    const all = await this.readCached();
    const collapsed = collapseById(all);
    const matches = collapsed.filter(
      (r) => r.idempotencyKey === key && (sessionId === undefined || r.sessionId === sessionId),
    );
    return matches.length > 0 ? matches[matches.length - 1]! : null;
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

// ---------------------------------------------------------------------------
// Bounded per-session reader (outcomes computation at SessionEnd)
// ---------------------------------------------------------------------------

/** Options for {@link readEffectsForSession}. */
export interface ReadEffectsForSessionOptions {
  /** Ledger path override (tests). Defaults to `getEffectLedgerPath()`. */
  path?: string;
  /** Stop after this many matching rows. Default 2000. */
  maxRecords?: number;
  /** Shared SessionEnd deadline; abort/size exhaustion must not masquerade as empty evidence. */
  budget?: InputBudget;
}

/**
 * Stream the ledger and return the raw rows (pending + settled, unfolded)
 * whose `sessionId` matches. The file can be MBs, so it is streamed line by
 * line rather than loaded whole. ENOENT yields []. Other I/O errors
 * propagate — callers on the teardown path must catch.
 */
async function* readBoundedEffects(path: string, budget: InputBudget): AsyncGenerator<EffectRecord> {
  for await (const line of boundedLines(path, budget)) {
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (isEffectRecord(rec)) yield rec;
  }
}

export async function readEffectsForSession(
  sessionId: string,
  opts: ReadEffectsForSessionOptions = {},
): Promise<EffectRecord[]> {
  const max = opts.maxRecords ?? 2000;
  const out: EffectRecord[] = [];
  const path = opts.path ?? getEffectLedgerPath();
  const iter = opts.budget ? readBoundedEffects(path, opts.budget)
    : readJsonlFile<EffectRecord>(path, { guard: isEffectRecord });
  for await (const rec of iter) {
    if (rec.sessionId !== sessionId) continue;
    out.push(rec);
    if (out.length >= max) {
      if (opts.budget) throw new Error('outcomes ledger record limit exceeded');
      break;
    }
  }
  return out;
}
