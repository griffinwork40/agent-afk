/**
 * `LspServerPool` (#4272 stage 3): one warm language server per
 * (workspace root, language, command) for the process lifetime, with idle
 * shutdown, crash eviction, and exit cleanup.
 *
 * Invariants:
 *   - Concurrent `acquire`s for the same key share ONE in-flight start.
 *   - A dead client (crash, exit, failed start) is evicted immediately; the
 *     next `acquire` spawns a fresh one. A dead handle is never returned.
 *   - A start abandoned only by cancellation (abort) is grace-killed so it
 *     cannot linger forever. A start whose last acquirer timed out instead
 *     keeps warming under the client's own initialize deadline: a healthy slow
 *     server then becomes available to the next caller, and a genuinely hung
 *     one is counted once per 30 s and trips the guard after three.
 *   - Idle timers are `.unref()`ed and every live server is disposed on
 *     graceful cleanup via `registerCleanup`; client-process guards hard exit.
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
import { CrashLoopGuard, getOrCreateGuard } from './crash-loop-guard.js';
import type { ServerSpec } from './server-spec.js';

/**
 * How long a start abandoned by every acquirer (timeout/abort) may keep
 * initializing in the background before it is killed. Lets a cold server
 * that misses one short diagnostics budget finish warming for the next call,
 * without leaving a never-initializing process behind.
 */
export const ABANDONED_START_GRACE_MS = 1_000;

/**
 * A client exit within this long of its latest request timeout is treated as
 * fallout of that already-counted timeout, not a new crash-loop incident. A
 * later exit (the timeout does not kill the client) is counted.
 */
export const TIMEOUT_EXIT_FALLOUT_MS = 5_000;

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
  /**
   * Override crash-loop guard construction (tests). Called with the pool key
   * whenever a new guard is needed. Default: `getOrCreateGuard(key)`.
   */
  readonly guardFor?: (key: string) => CrashLoopGuard;
}

interface Entry {
  readonly key: string;
  client: LspClient | null;
  starting: Promise<LspClient> | null;
  /** Acquirers currently waiting on `starting`. */
  waiters: number;
  /** How many of the current/past waiters gave up via timeout (not abort). */
  timedOutWaiters: number;
  abortStart: AbortController;
  /**
   * Fired when the last timeout-abandoned acquirer gives up: unrefs the
   * in-flight process without aborting it, so a one-shot `afk chat` process
   * can exit while the server keeps warming.
   */
  unrefStart: AbortController;
  lastAcquiredAt: number;
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
   *
   * Rejects with `LspClientError` kind `'exited'` when the crash-loop guard
   * has tripped for this server (3 crashes within 120 s): the caller should
   * silently degrade rather than retry.
   */
  async acquire(spec: ServerSpec, root: string, opts: AcquireOptions = {}): Promise<LspClient> {
    if (opts.signal?.aborted) throw new LspClientError('aborted', 'Aborted');
    const key = poolKey(spec, root);
    // Check crash-loop guard before attempting any spawn.
    const guard = (this.opts.guardFor ?? getOrCreateGuard)(key);
    if (guard.failed) {
      throw new LspClientError('exited', 'LSP server disabled: crash-loop guard tripped');
    }
    let entry = this.entries.get(key);
    if (entry?.client && !entry.client.alive) {
      this.evict(entry);
      entry = undefined;
    }
    if (entry?.client) {
      entry.lastAcquiredAt = Date.now();
      return entry.client;
    }
    if (!entry) entry = this.createEntry(key, spec, realpathOr(root), guard);
    return this.waitForStart(entry, opts);
  }

  private createEntry(key: string, spec: ServerSpec, root: string, guard: CrashLoopGuard): Entry {
    const entry: Entry = {
      key, client: null, starting: null, waiters: 0, timedOutWaiters: 0,
      abortStart: new AbortController(), unrefStart: new AbortController(),
      idleTimer: null, abandonTimer: null,
      lastAcquiredAt: Date.now(),
    };
    this.entries.set(key, entry);
    this.spawnCount++;
    const start = this.opts.startClient
      ? this.opts.startClient(spec, root)
      : LspClient.start(spec, root, { signal: entry.abortStart.signal, unrefSignal: entry.unrefStart.signal });
    entry.starting = start.then(
      (client) => {
        entry.starting = null;
        if (this.entries.get(key) !== entry || entry.abortStart.signal.aborted || !client.alive) {
          void client.dispose();
          throw new LspClientError('exited', 'LSP server exited before responding');
        }
        entry.client = client;
        entry.lastAcquiredAt = Date.now();
        // Each timed-out request counts; an exit shortly after one is its
        // fallout, not a new incident. A tripping timeout evicts the hung
        // client (evict-first, so its exit is not counted again).
        let lastTimeoutAt: number | null = null;
        client.onRequestTimeout(() => {
          if (this.entries.get(key) !== entry) return;
          lastTimeoutAt = Date.now();
          if (guard.recordCrash()) this.evict(entry);
        });
        client.onExit(() => {
          if (this.entries.get(key) === entry) {
            const fallout = lastTimeoutAt !== null && Date.now() - lastTimeoutAt <= TIMEOUT_EXIT_FALLOUT_MS;
            if (!fallout) guard.recordCrash();
            this.evict(entry);
          }
        });
        this.scheduleIdle(entry);
        return client;
      },
      (err: unknown) => {
        if (this.entries.get(key) === entry) {
          // A failed shared start counts once here, never per acquirer.
          // RULE: only genuine start failures count — process crash/exit during
          // start, or the client's own initialize deadline. A start abandoned by
          // callers (grace-killed) never reaches here as an incident; by the time
          // this rejection lands the entry is already evicted, so the guard
          // check below is skipped. Cancellation and missing binaries excluded.
          const lspErr = err instanceof LspClientError ? err : null;
          if (!lspErr || (lspErr.kind !== 'spawn' && lspErr.kind !== 'aborted')) guard.recordCrash();
          this.evict(entry);
        }
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
    let gaveUpByTimeout = false;
    let gaveUpByAbort = false;
    try {
      return await Promise.race([starting, guard]);
    } catch (err) {
      if (err instanceof LspClientError) {
        if (err.kind === 'timeout') gaveUpByTimeout = true;
        else if (err.kind === 'aborted') gaveUpByAbort = true;
      }
      throw err;
    } finally {
      for (const c of cleanups) c();
      if (gaveUpByTimeout) entry.timedOutWaiters++;
      entry.waiters--;
      const isLast = (gaveUpByTimeout || gaveUpByAbort) && entry.waiters === 0
        && entry.starting !== null && this.entries.get(entry.key) === entry;
      if (isLast && entry.timedOutWaiters > 0) {
        // At least one acquirer timed out: let the start keep warming under
        // the client's own initialize deadline. Count a real initialize
        // timeout or crash when it lands; a healthy slow server becomes
        // available to the next caller. Unref the process so it won't hold
        // a finished one-shot `afk chat` process open.
        entry.unrefStart.abort();
      } else if (isLast) {
        // Every acquirer aborted (no timeout): short grace then kill.
        // Grace-killed starts are never incidents: callers' patience says
        // nothing about server health.
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

  private scheduleIdle(entry: Entry, delayMs?: number): void {
    const idleMs = this.opts.idleShutdownMs ?? getIdleShutdownMs();
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      const client = entry.client;
      if (!client || this.entries.get(entry.key) !== entry) return;
      const idleFor = Date.now() - Math.max(client.lastActivityAt, entry.lastAcquiredAt);
      if (client.pendingRequests > 0 || idleFor < idleMs) {
        this.scheduleIdle(entry, client.pendingRequests > 0 ? idleMs : idleMs - idleFor);
        return;
      }
      this.evict(entry);
    }, delayMs ?? idleMs);
    entry.idleTimer.unref();
  }

  private evict(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.abandonTimer) clearTimeout(entry.abandonTimer);
    entry.idleTimer = null;
    entry.abandonTimer = null;
    // Clean up the unref listener in case evict fires before unrefStart was
    // triggered (e.g. disposeAll aborts the start directly).
    entry.unrefStart.abort();
    const client = entry.client;
    entry.client = null;
    if (client) void client.dispose();
  }

  /**
   * Synchronous best-effort kill of every pooled client. Safe to call from a
   * `process.on('exit')` handler. Complements `disposeAll()` (which is async
   * and only reachable from interactive exit paths) by covering daemon,
   * one-shot, and Telegram process exits (#4309 item 2).
   */
  killAll(): void {
    for (const entry of this.entries.values()) {
      entry.abortStart.abort();
      const client = entry.client;
      if (client) client.killSync();
    }
    this.entries.clear();
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

/** Process-wide pool singleton; registers graceful cleanup on first use. */
export function getLspPool(): LspServerPool {
  if (!pool) {
    const created = new LspServerPool();
    pool = created;
    // Graceful draining is async. The spawn-time guardian in client-process
    // independently covers ready, starting, and disposing servers on hard exit
    // (direct-root fallback on win32; no blocking taskkill per pooled server).
    registerCleanup(() => created.disposeAll());
  }
  return pool;
}
