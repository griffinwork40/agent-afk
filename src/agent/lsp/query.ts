/**
 * One-shot query helper over the persistent pool: acquire the warm server for
 * (spec, root), sync one file, run `fn`, all under a single deadline + signal.
 * Shared by the `code_symbols` and post-edit diagnostics handlers.
 *
 * Invariant: never hangs past `timeoutMs` / abort. Failures surface as
 * `LspClientError` (kind drives the handler's error string); the handlers
 * convert them into their silent-degrade `{ error }` / `[]` results.
 *
 * @module agent/lsp/query
 */

import { pathToFileURL } from 'node:url';
import { LspClient, LspClientError, type FileSync } from './client.js';
import { getLspPool, type LspServerPool } from './pool.js';
import type { PublishedDiagnostics } from './diagnostics-store.js';
import type { ServerSpec } from './server-spec.js';
import { MutexRegistry } from './async-mutex.js';

// Invariant: concurrent withPooledFile calls for the same (client, uri) must
// serialise the syncFile+fn pair so two didChange notifications cannot race
// and overwrite each other's content on the server.
const syncLocks = new MutexRegistry();

// Stable numeric IDs for LspClient instances (no id property on the class).
const clientIds = new WeakMap<LspClient, number>();
let nextClientId = 1;
function clientId(c: LspClient): number {
  let id = clientIds.get(c);
  if (id === undefined) { id = nextClientId++; clientIds.set(c, id); }
  return id;
}

export interface PooledQueryOptions {
  /** Workspace root the server is keyed and spawned on. */
  readonly root: string;
  /** Total budget for acquire (cold start included) + sync + `fn`. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Pool override (tests). Default: the process-wide pool. */
  readonly pool?: LspServerPool;
}

/** Per-query context handed to `fn`. */
export interface QueryContext {
  readonly client: LspClient;
  readonly sync: FileSync;
  /** `client.diagnostics.seq` captured just before the sync notification. */
  readonly seqBeforeSync: number;
  /** Milliseconds left in the budget (never negative). */
  remainingMs(): number;
}

/**
 * Acquire, sync `filePath` (with `content`), then run `fn`. Throws
 * `LspClientError` ('timeout' | 'aborted' | 'spawn' | 'exited' | 'response').
 */
export async function withPooledFile<T>(
  spec: ServerSpec,
  filePath: string,
  content: string,
  opts: PooledQueryOptions,
  fn: (ctx: QueryContext) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const pool = opts.pool ?? getLspPool();
  const client = await pool.acquire(spec, opts.root, { timeoutMs: remainingMs(), signal: opts.signal });
  const release = client.hold();
  const releaseDoc = client.useDocument(pathToFileURL(filePath).toString());
  // Invariant: per-(client, uri) mutex serialises the syncFile+fn pair so
  // concurrent queries (e.g. diagnostics + symbols for the same file) cannot
  // interleave didChange notifications and corrupt the server's buffer state.
  const syncKey = `${clientId(client)}:${pathToFileURL(filePath).toString()}`;
  const releaseSyncLock = await syncLocks.get(syncKey).acquire();
  let syncedUri: string | null = null;
  let releasedSyncLock = false;
  try {
    // Invariant: inactive open copies must be closed BEFORE the request, so
    // cross-file answers use disk rather than another route's stale edit.
    // useDocument holds preserve any documents concurrent queries still need.
    client.closeOthers(pathToFileURL(filePath).toString());
    const seqBeforeSync = client.diagnostics.seq;
    const sync = await client.syncFile(filePath, content);
    if (!sync) throw new LspClientError('response', 'Unsupported file type');
    syncedUri = sync.uri;
    // Invariant: release the sync lock after syncFile completes, before fn.
    // The mutex only protects the didChange notification itself; holding it
    // across awaitSyncDiagnostics inside fn would block concurrent queries
    // for the same file unnecessarily.
    releaseSyncLock();
    releasedSyncLock = true;
    return await fn({ client, sync, seqBeforeSync, remainingMs });
  } finally {
    if (!releasedSyncLock) releaseSyncLock();
    syncLocks.releaseIfIdle(syncKey);
    // Also prune documents whose concurrent query holds have now released.
    releaseDoc();
    if (syncedUri !== null) client.closeOthers(syncedUri);
    release();
  }
}

/**
 * Wait for the publishDiagnostics matching this sync. A changed document
 * waits for a publish newer than the sync (version-matched when the
 * server reports versions); an unchanged one accepts the latest publish for
 * its version. Resolves null on timeout, abort, or server death.
 */
export function awaitSyncDiagnostics(
  ctx: QueryContext,
  signal?: AbortSignal,
): Promise<PublishedDiagnostics | null> {
  const { client, sync } = ctx;
  const afterSeq = sync.changed ? ctx.seqBeforeSync : 0;
  return new Promise((resolve) => {
    const unsubscribe = client.onExit(() => resolve(null));
    void client.diagnostics
      .waitFor(sync.uri, sync.version, afterSeq, ctx.remainingMs(), signal)
      .then((p) => {
        unsubscribe();
        resolve(p);
      });
  });
}
