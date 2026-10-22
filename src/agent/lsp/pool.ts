/**
 * `LspServerPool` (#4272 stage 3): one warm language server per
 * (workspace root, language, command) for the process lifetime, with idle
 * shutdown, crash eviction, and exit cleanup.
 *
 * Invariants:
 *   - Concurrent `acquire`s for the same key share ONE in-flight start.
 *   - A dead client (crash, exit, failed start) is evicted immediately; the
 *     next `acquire` spawns a fresh one. A dead handle is never returned.
 *   - A start that every acquirer has abandoned (timeout/abort) is disposed,
 *     so a server that never finishes `initialize` is not left orphaned.
 *   - Idle timers are `.unref()`ed and every live server is disposed on
 *     process exit via `registerCleanup`.
 *
 * Key deviation from the #4272 contract wording: the key also includes the
 * spec's command + args, so two different binaries for the same language and
 * root (e.g. an injected test/override server) never share a process.
 *
 * @module agent/lsp/pool
 */

import { realpathSync } from 'node:fs';
import { env } from '../../config/env.js';
import { registerCleanup } from '../../utils/cleanupRegistry.js';
import { LspClient, LspClientError } from './client.js';
import type { ServerSpec } from './server-spec.js';

/**
 * How long a start abandoned by every acquirer (timeout/abort) may keep
 * initializing in the background before it is killed. Lets a cold server
 * that misses one short diagnostics budget finish warming for the next call,
 * without leaving a never-initializing process behind.
 */
export const ABANDONED_START_GRACE_MS = 1_000;

/** Default idle shutdown: 5 minutes without a request. */
export const DEFAULT_LSP_IDLE_SHUTDOWN_MS = 300_000;

/** Idle-shutdown window from `AFK_LSP_IDLE_SHUTDOWN_MS` (default 300000). */
export function getIdleShutdownMs(): number {
  const raw = env.AFK_LSP_IDLE_SHUTDOWN_MS;
  if (!raw) return DEFAULT_LSP_IDLE_SHUTDOWN_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LSP_IDLE_SHUTDOWN_MS;
}

export interface AcquireOptions {
  readonly signal?: AbortSignal;
  /** Caller's deadline for getting a ready client (cold start included). */
  readonly timeoutMs?: number;
}

export interface LspServerPoolOptions {
  /** Override the idle window (tests). Default: `getIdleShutdownMs()` at schedule time. */
  readonly idleShutdownMs?: number;
  /** Override `ABANDONED_START_GRACE_MS` (tests). */
  readonly abandonedStartGraceMs?: number;
  /** Override client construction (tests). */
  readonly startClient?: (spec: ServerSpec, root: string) => Promise<LspClient>;
}

interface Entry {
  readonly key: string;
  client: LspClient | null;
  starting: Promise<LspClient> | null;
  /** Acquirers currently waiting on `starting`. */
  waiters: number;
  abortStart: AbortController;
  idleTimer: NodeJS.Timeout | null;
  abandonTimer: NodeJS.Timeout | null;
}

function realpathOr(p: string): string {
  try { return realpathSync.native(p); } catch { return p; }
}

/** Pool key: realpath(root) + language + command line. */
export function poolKey(spec: ServerSpec, root: string): string {
  return JSON.stringify([realpathOr(root), spec.definition.language, spec.command, spec.args]);
}

export class LspServerPool {
  private readonly entries = new Map<string, Entry>();
  private spawnCount = 0;

  constructor(private readonly opts: LspServerPoolOptions = {}) {}

  /** Number of clients this pool has started (tests / diagnostics). */
  get spawned(): number {
    return this.spawnCount;
  }

  /** Number of live or starting entries. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Return a ready client for (`spec`, `root`), starting one if needed.
   * Rejects with `LspClientError` on spawn failure, crash during start,
   * timeout, or abort. Never returns a dead client.
   */
  async acquire(spec: ServerSpec, root: string, opts: AcquireOptions = {}): Promise<LspClient> {
    if (opts.signal?.aborted) throw new LspClientError('aborted', 'Aborted');
    const key = poolKey(spec, root);
    let entry = this.entries.get(key);
    if (entry?.client && !entry.client.alive) {
      this.evict(entry);
      entry = undefined;
    }
    if (entry?.client) {
      this.scheduleIdle(entry);
      return entry.client;
    }
    if (!entry) entry = this.createEntry(key, spec, realpathOr(root));
    return this.waitForStart(entry, opts);
  }

  private createEntry(key: string, spec: ServerSpec, root: string): Entry {
    const entry: Entry = {
      key, client: null, starting: null, waiters: 0,
      abortStart: new AbortController(), idleTimer: null, abandonTimer: null,
    };
    this.entries.set(key, entry);
    this.spawnCount++;
    const start = this.opts.startClient
      ? this.opts.startClient(spec, root)
      : LspClient.start(spec, root, { signal: entry.abortStart.signal });
    entry.starting = start.then(
      (client) => {
        entry.starting = null;
        if (this.entries.get(key) !== entry || entry.abortStart.signal.aborted || !client.alive) {
          void client.dispose();
          throw new LspClientError('exited', 'LSP server exited before responding');
        }
        entry.client = client;
        client.onExit(() => { if (this.entries.get(key) === entry) this.evict(entry); });
        this.scheduleIdle(entry);
        return client;
      },
      (err: unknown) => {
        if (this.entries.get(key) === entry) this.evict(entry);
        throw err instanceof LspClientError ? err : new LspClientError('spawn', 'Failed to spawn LSP server');
      },
    );
    entry.starting.catch(() => { /* observed by waiters */ });
    return entry;
  }

  private async waitForStart(entry: Entry, opts: AcquireOptions): Promise<LspClient> {
    const starting = entry.starting;
    if (!starting) throw new LspClientError('exited', 'LSP server exited before responding');
    entry.waiters++;
    if (entry.abandonTimer) clearTimeout(entry.abandonTimer);
    entry.abandonTimer = null;
    const cleanups: Array<() => void> = [];
    const guard = new Promise<never>((_, reject) => {
      if (opts.timeoutMs !== undefined) {
        const t = setTimeout(() => reject(new LspClientError('timeout', 'LSP server start timed out')), opts.timeoutMs);
        t.unref();
        cleanups.push(() => clearTimeout(t));
      }
      if (opts.signal) {
        const onAbort = () => reject(new LspClientError('aborted', 'Aborted'));
        opts.signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => opts.signal?.removeEventListener('abort', onAbort));
      }
    });
    let gaveUp = false;
    try {
      return await Promise.race([starting, guard]);
    } catch (err) {
      gaveUp = err instanceof LspClientError && (err.kind === 'timeout' || err.kind === 'aborted');
      throw err;
    } finally {
      for (const c of cleanups) c();
      entry.waiters--;
      // Last acquirer gave up on a still-starting server: give it a short
      // grace to finish warming, then kill it so it cannot linger forever.
      if (gaveUp && entry.waiters === 0 && entry.starting && this.entries.get(entry.key) === entry) {
        entry.abandonTimer = setTimeout(() => {
          entry.abandonTimer = null;
          if (entry.starting && entry.waiters === 0 && this.entries.get(entry.key) === entry) {
            entry.abortStart.abort();
            this.evict(entry);
          }
        }, this.opts.abandonedStartGraceMs ?? ABANDONED_START_GRACE_MS);
        entry.abandonTimer.unref();
      }
    }
  }

  private scheduleIdle(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const idleMs = this.opts.idleShutdownMs ?? getIdleShutdownMs();
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      const client = entry.client;
      if (!client || this.entries.get(entry.key) !== entry) return;
      const idleFor = Date.now() - client.lastActivityAt;
      if (client.pendingRequests > 0 || idleFor < idleMs) {
        this.scheduleIdle(entry);
        return;
      }
      this.evict(entry);
    }, idleMs);
    entry.idleTimer.unref();
  }

  private evict(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.abandonTimer) clearTimeout(entry.abandonTimer);
    entry.idleTimer = null;
    entry.abandonTimer = null;
    const client = entry.client;
    entry.client = null;
    if (client) void client.dispose();
  }

  /** Dispose every server (tests, process exit). */
  async disposeAll(): Promise<void> {
    const all = [...this.entries.values()];
    const clients = all.map((e) => e.client).filter((c): c is LspClient => c !== null);
    // A still-starting entry disposes its own client (and awaits its exit)
    // once the abort lands; wait for that too so callers can rm the cwd.
    const starting = all.map((e) => e.starting).filter((p): p is Promise<LspClient> => p !== null);
    for (const e of all) {
      e.abortStart.abort();
      this.evict(e);
    }
    await Promise.all([
      ...clients.map((c) => c.dispose()),
      ...starting.map((p) => p.then((c) => c.dispose(), () => undefined)),
    ]);
  }
}

let pool: LspServerPool | null = null;

/** Process-wide pool singleton; registers exit cleanup on first use. */
export function getLspPool(): LspServerPool {
  if (!pool) {
    const created = new LspServerPool();
    pool = created;
    registerCleanup(() => created.disposeAll());
  }
  return pool;
}
