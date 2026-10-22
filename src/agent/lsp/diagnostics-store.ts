/**
 * Tracks `textDocument/publishDiagnostics` per uri for a persistent client and
 * lets callers wait for a publish newer than a given point (and matching a
 * document version when the server reports one).
 *
 * @module agent/lsp/diagnostics-store
 */

export interface PublishedDiagnostics {
  readonly uri: string;
  readonly version?: number;
  readonly diagnostics: readonly unknown[];
  /** Monotonic arrival sequence number (store-local). */
  readonly seq: number;
}

interface Waiter {
  readonly uri: string;
  readonly version: number | undefined;
  readonly afterSeq: number;
  readonly resolve: (p: PublishedDiagnostics) => void;
}

export class DiagnosticsStore {
  private seqCounter = 0;
  private readonly latest = new Map<string, PublishedDiagnostics>();
  private readonly waiters = new Set<Waiter>();

  /** Current sequence position; pass to `waitFor` as `afterSeq`. */
  get seq(): number {
    return this.seqCounter;
  }

  /** Record a raw publishDiagnostics params object. Malformed input is ignored. */
  record(params: unknown): void {
    if (typeof params !== 'object' || params === null) return;
    const p = params as { uri?: unknown; version?: unknown; diagnostics?: unknown };
    if (typeof p.uri !== 'string') return;
    const entry: PublishedDiagnostics = {
      uri: p.uri,
      ...(typeof p.version === 'number' ? { version: p.version } : {}),
      diagnostics: Array.isArray(p.diagnostics) ? p.diagnostics : [],
      seq: ++this.seqCounter,
    };
    this.latest.set(p.uri, entry);
    for (const w of [...this.waiters]) {
      if (matches(entry, w)) {
        this.waiters.delete(w);
        w.resolve(entry);
      }
    }
  }

  /**
   * Resolve with the first publish for `uri` that arrived after `afterSeq`
   * and whose `version` (if reported) equals `version` (if given). Resolves
   * immediately when the latest recorded publish already qualifies, and with
   * null on timeout/abort. Never rejects.
   */
  waitFor(
    uri: string,
    version: number | undefined,
    afterSeq: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PublishedDiagnostics | null> {
    const existing = this.latest.get(uri);
    const probe = { uri, version, afterSeq };
    if (existing && matches(existing, probe)) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (v: PublishedDiagnostics | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(waiter);
        resolve(v);
      };
      const onAbort = () => finish(null);
      const waiter: Waiter = { ...probe, resolve: finish };
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }
}

function matches(entry: PublishedDiagnostics, w: Pick<Waiter, 'uri' | 'version' | 'afterSeq'>): boolean {
  if (entry.uri !== w.uri || entry.seq <= w.afterSeq) return false;
  return entry.version === undefined || w.version === undefined || entry.version === w.version;
}
