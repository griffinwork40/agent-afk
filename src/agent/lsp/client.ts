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

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { ServerSpec } from './server-spec.js';
import { answerServerRequest, CLIENT_CAPABILITIES } from './client-handlers.js';
import { DocumentSync, type SyncResult } from './document-sync.js';
import { DiagnosticsStore } from './diagnostics-store.js';

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

/** Default deadline for the `initialize` handshake when the caller gives none. */
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

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

  private constructor(
    readonly spec: ServerSpec,
    readonly root: string,
    private readonly proc: ChildProcess,
  ) {
    proc.stdin?.on('error', () => this.markDead('stdin error'));
    proc.on('error', () => this.markDead('spawn error', 'spawn'));
    proc.on('exit', () => this.markDead('process exited'));
    this.conn = createMessageConnection(
      new StreamMessageReader(proc.stdout!),
      new StreamMessageWriter(proc.stdin!),
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
      // Invariant: on win32 npm-installed binaries are .cmd shims that spawn()
      // cannot resolve without shell: true.
      proc = spawn(spec.command, [...spec.args], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
      });
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
        const fail = (err: LspClientError) => { cts.cancel(); reject(err); };
        this.deathWaiters.add(fail);
        cleanups.push(() => this.deathWaiters.delete(fail));
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

  /** Graceful shutdown/exit, then kill. Idempotent; never throws. */
  dispose(): Promise<void> {
    this.disposing ??= this.doDispose();
    return this.disposing;
  }

  private async doDispose(): Promise<void> {
    // Only a server that finished initialize gets a graceful shutdown; one
    // stuck in initialize is killed immediately.
    if (!this.dead && this.initialized) {
      try { await this.request('shutdown', null, { timeoutMs: 1000 }); } catch { /* best effort */ }
      this.notify('exit', null);
    }
    this.markDead('disposed');
    try { this.proc.stdin?.end(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
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
    if (reason !== 'disposed') {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
  }
}
