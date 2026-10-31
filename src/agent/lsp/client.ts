/**
 * Persistent LSP client (#4272 stage 3): one spawned language server plus its
 * JSON-RPC connection (vscode-jsonrpc over stdio), initialized once and
 * reused across queries by `LspServerPool`.
 *
 * Invariants:
 *   - Every server-to-client request is answered (see client-handlers.ts).
 *   - A dead client (exit, spawn error, stream close) is never revived; the
 *     pool evicts it via `onExit` and spawns a fresh one.
 *   - `request` never hangs past its timeout/abort: it races the response
 *     against the deadline, the signal, and process death, and sends
 *     `$/cancelRequest` when abandoning an in-flight request.
 *
 * @module agent/lsp/client
 */

import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type Logger,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { ServerSpec } from './server-spec.js';
import { answerServerRequest, CLIENT_CAPABILITIES } from './client-handlers.js';
import { DocumentSync, type SyncResult } from './document-sync.js';
import { DiagnosticsStore } from './diagnostics-store.js';
import { exitPromise, forceKillRoot, killServerTree, killServerTreeAndWait, spawnServer, waitForExit } from './client-process.js';

/** Failure kinds surfaced to handlers so they can map to their error strings. */
export type LspFailureKind = 'timeout' | 'aborted' | 'exited' | 'spawn' | 'response';

/** Error thrown by `LspClient` operations. `kind` drives handler messages. */
export class LspClientError extends Error {
  constructor(readonly kind: LspFailureKind, message: string) {
    super(message);
    this.name = 'LspClientError';
  }
}

export interface RequestOptions {
  /** Per-call deadline in ms. Absent = no deadline (signal/death still apply). */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Result of `syncFile`: the document uri plus the sync outcome. */
export interface FileSync extends SyncResult {
  readonly uri: string;
}

/** vscode-jsonrpc logs connection errors to the console by default; stay silent. */
const SILENT_LOGGER: Logger = { error: () => {}, warn: () => {}, info: () => {}, log: () => {} };

/** Default deadline for the `initialize` handshake when the caller gives none. */
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

/** Upper bound `dispose` waits for the process to exit after the kill. */
export const DISPOSE_EXIT_TIMEOUT_MS = 3_000;

export class LspClient {
  private readonly conn: MessageConnection;
  private readonly docs = new DocumentSync();
  readonly diagnostics = new DiagnosticsStore();
  private dead = false;
  private readonly exitListeners = new Set<() => void>();
  private readonly deathWaiters = new Set<(err: LspClientError) => void>();
  private inFlight = 0;
  private lastActivity = Date.now();
  private disposing: Promise<void> | null = null;
  private holds = 0;
  private initialized = false;
  private readonly exited: Promise<void>;
  /** Uris an in-flight query is using; never closed underneath it. */
  private readonly docUses = new Map<string, number>();

  private constructor(
    readonly spec: ServerSpec,
    readonly root: string,
    private readonly proc: ChildProcess,
  ) {
    this.exited = exitPromise(proc);
    proc.stdin?.on('error', () => this.markDead('stdin error'));
    proc.on('error', () => this.markDead('spawn error', 'spawn'));
    proc.on('exit', () => this.markDead('process exited'));
    this.conn = createMessageConnection(
      new StreamMessageReader(proc.stdout!),
      new StreamMessageWriter(proc.stdin!),
      SILENT_LOGGER,
    );
    this.conn.onRequest((method: string, params: unknown) => answerServerRequest(spec.definition, method, params));
    this.conn.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
      this.diagnostics.record(params);
    });
    this.conn.onClose(() => this.markDead('connection closed'));
    this.conn.onError(() => { /* stream errors surface via close/exit */ });
    this.conn.listen();
    this.setRef(false);
  }

  /**
   * Keep the event loop alive while a caller awaits this server. An idle warm
   * server is unref'd so it never holds a finished one-shot process open.
   * Returns the release function (idempotent).
   */
  hold(): () => void {
    if (this.holds++ === 0) this.setRef(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0) this.setRef(false);
    };
  }

  private setRef(on: boolean): void {
    const handles = [this.proc, this.proc.stdout, this.proc.stdin] as Array<{ ref?: () => void; unref?: () => void } | null>;
    for (const h of handles) {
      try { if (on) h?.ref?.(); else h?.unref?.(); } catch { /* ignore */ }
    }
  }

  /**
   * Spawn `spec` with cwd `root` and run initialize/initialized. Throws
   * `LspClientError` on spawn failure, early exit, timeout, or abort (the
   * process is killed in every failure case).
   */
  static async start(spec: ServerSpec, root: string, opts: RequestOptions = {}): Promise<LspClient> {
    if (opts.signal?.aborted) throw new LspClientError('aborted', 'Aborted');
    let proc: ChildProcess;
    try {
      // Invariant: never spawned through a shell; win32 .cmd shims are
      // resolved to their JS entry (client-process.ts) so pid IS the server.
      proc = spawnServer(spec.command, spec.args, root);
    } catch {
      throw new LspClientError('spawn', 'Failed to spawn LSP server');
    }
    const client = new LspClient(spec, root, proc);
    try {
      await client.initialize(opts);
      return client;
    } catch (err) {
      await client.dispose();
      throw err;
    }
  }

  private async initialize(opts: RequestOptions): Promise<void> {
    const rootUri = pathToFileURL(this.root).toString();
    await this.request('initialize', {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) || 'workspace' }],
      initializationOptions: this.spec.definition.initializationOptions,
      capabilities: CLIENT_CAPABILITIES,
    }, { timeoutMs: opts.timeoutMs ?? DEFAULT_INIT_TIMEOUT_MS, signal: opts.signal });
    // LSP spec §3.4.1: `initialized` MUST be sent after the `initialize`
    // response has been received. The `await` above guarantees that, so this
    // notification is spec-compliant. Note: some servers (e.g. typescript-
    // language-server) also tolerate `initialized` arriving before the response
    // ACK; we rely on the stricter sequencing that `await` gives us here.
    this.notify('initialized', {});
    this.initialized = true;
  }

  /** True until the process exits, errors, or is disposed. */
  get alive(): boolean {
    return !this.dead;
  }

  /** Number of requests currently awaiting a response. */
  get pendingRequests(): number {
    return this.inFlight;
  }

  /** Epoch ms of the last request/notify/sync. */
  get lastActivityAt(): number {
    return this.lastActivity;
  }

  /** Subscribe to death (exit/crash/dispose). Fires at most once. */
  onExit(cb: () => void): () => void {
    if (this.dead) {
      queueMicrotask(cb);
      return () => {};
    }
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /** Send a request. Rejects with `LspClientError`; never hangs past timeout/abort/death. */
  async request<R = unknown>(method: string, params: unknown, opts: RequestOptions = {}): Promise<R> {
    if (this.dead) throw new LspClientError('exited', 'LSP server exited before responding');
    if (opts.signal?.aborted) throw new LspClientError('aborted', 'Aborted');
    this.touch();
    this.inFlight++;
    const release = this.hold();
    const cts = new CancellationTokenSource();
    const cleanups: Array<() => void> = [];
    try {
      const response = this.conn.sendRequest<R>(method, params, cts.token);
      response.catch(() => { /* superseded by a race loser; never unhandled */ });
      const guard = new Promise<never>((_, reject) => {
        // Abandoning a live request sends `$/cancelRequest`; a dead
        // connection cannot carry it, so death only rejects.
        const fail = (err: LspClientError) => {
          if (!this.dead) { try { cts.cancel(); } catch { /* closed */ } }
          reject(err);
        };
        this.deathWaiters.add(reject);
        cleanups.push(() => this.deathWaiters.delete(reject));
        if (opts.timeoutMs !== undefined) {
          const t = setTimeout(() => fail(new LspClientError('timeout', `LSP ${method} timed out`)), opts.timeoutMs);
          t.unref();
          cleanups.push(() => clearTimeout(t));
        }
        if (opts.signal) {
          const onAbort = () => fail(new LspClientError('aborted', 'Aborted'));
          opts.signal.addEventListener('abort', onAbort, { once: true });
          cleanups.push(() => opts.signal?.removeEventListener('abort', onAbort));
        }
      });
      try {
        return await Promise.race([response, guard]);
      } catch (err) {
        if (err instanceof LspClientError) throw err;
        throw new LspClientError('response', 'LSP server returned an error');
      }
    } finally {
      for (const c of cleanups) c();
      cts.dispose();
      release();
      this.inFlight--;
      this.touch();
    }
  }

  /** Fire-and-forget notification. No-op on a dead client. */
  notify(method: string, params: unknown): void {
    if (this.dead) return;
    this.touch();
    this.conn.sendNotification(method, params).catch(() => { /* dead pipe */ });
  }

  /**
   * Read `filePath` from disk and sync it: didOpen on first touch, didChange
   * (full text, version++) when the content changed, nothing otherwise.
   * Returns null when the extension has no languageId in the definition.
   * `content` skips the disk read when the caller already has the text.
   * Rejects when the file cannot be read.
   */
  async syncFile(filePath: string, content?: string): Promise<FileSync | null> {
    const languageId = this.spec.definition.languageIds[path.extname(filePath).toLowerCase()];
    if (!languageId) return null;
    const text = content ?? await readFile(filePath, 'utf8');
    const uri = pathToFileURL(filePath).toString();
    const result = this.docs.sync(uri, languageId, text);
    if (result.notification) this.notify(result.notification.method, result.notification.params);
    return { ...result, uri };
  }

  /** Mark `uri` in use by a query until the returned release is called. */
  useDocument(uri: string): () => void {
    this.docUses.set(uri, (this.docUses.get(uri) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.docUses.get(uri) ?? 1) - 1;
      if (n <= 0) this.docUses.delete(uri); else this.docUses.set(uri, n);
    };
  }

  /**
   * didClose every open document except `uri` and any document an in-flight
   * query is using (call before and after a query on `uri`). See
   * DocumentSync.closeAllExcept for why.
   */
  closeOthers(uri: string): void {
    const keep = new Set([uri, ...this.docUses.keys()]);
    for (const n of this.docs.closeAllExcept(keep)) this.notify(n.method, n.params);
  }

  /** Uris this client currently has open. */
  get openDocuments(): string[] {
    return this.docs.openUris();
  }

  /** Pid of the server process (tests / diagnostics). */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  /**
   * Graceful shutdown/exit, then kill the whole process tree and wait
   * (bounded by DISPOSE_EXIT_TIMEOUT_MS) for the exit. Idempotent; never throws.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.doDispose();
    return this.disposing;
  }

  private async doDispose(): Promise<void> {
    // Only a server that finished initialize gets a graceful `shutdown`; one
    // stuck in initialize is killed immediately.
    // Invariant: the tree is killed while the root is still alive (no `exit`
    // notification first) — on win32 `taskkill /T` cannot find the children
    // of a root that already exited, and they would keep the cwd busy.
    if (!this.dead && this.initialized) {
      try { await this.request('shutdown', null, { timeoutMs: 1000 }); } catch { /* best effort */ }
    }
    // Invariant: await taskkill's tree walk before stdin EOF can make the
    // root exit. Waiting only for root exit does not prove its children died.
    this.markDead('disposed');
    await killServerTreeAndWait(this.proc, DISPOSE_EXIT_TIMEOUT_MS);
    try { this.proc.stdin?.end(); } catch { /* ignore */ }
    await waitForExit(this.exited, DISPOSE_EXIT_TIMEOUT_MS);
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      forceKillRoot(this.proc);
      await waitForExit(this.exited, DISPOSE_EXIT_TIMEOUT_MS);
    }
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private markDead(reason: string, kind: LspFailureKind = 'exited'): void {
    if (this.dead) return;
    this.dead = true;
    const message = kind === 'spawn' ? 'Failed to spawn LSP server' : `LSP server exited before responding (${reason})`;
    const err = new LspClientError(kind, message);
    for (const w of [...this.deathWaiters]) w(err);
    this.deathWaiters.clear();
    for (const cb of [...this.exitListeners]) {
      try { cb(); } catch { /* listener errors never propagate */ }
    }
    this.exitListeners.clear();
    try { this.conn.dispose(); } catch { /* ignore */ }
    if (reason !== 'disposed') killServerTree(this.proc);
  }
}
