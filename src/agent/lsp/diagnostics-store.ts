/**
 * Tracks `textDocument/publishDiagnostics` per uri for a persistent client and
 * lets callers wait for a publish newer than a given point (and matching a
 * document version when the server reports one).
 *
 * Invariant (#4293 review C-3): the client advertises versionSupport so
 * compliant servers supply versions, which are matched exactly and returned
 * at once. UNVERSIONED diagnostics are explicitly best-effort: attribution
 * to an edit is impossible. Each matching publish restarts a quiet-window
 * debounce and the newest candidate is returned once the stream settles.
 * The caller's original timeout is never reset: on timeout the newest
 * candidate (if any) is returned instead of null.
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
  /** Called on every matching publish. */
  readonly offer: (p: PublishedDiagnostics) => void;
}

/** Default settle window for unversioned publishes. */
export const UNVERSIONED_SETTLE_MS = 200;

export class DiagnosticsStore {
  private seqCounter = 0;
  private readonly latest = new Map<string, PublishedDiagnostics>();
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly settleMs: number = UNVERSIONED_SETTLE_MS) {}

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
      if (matches(entry, w)) w.offer(entry);
    }
  }

  /**
   * Resolve with the publish for `uri` that arrived after `afterSeq` and
   * whose `version` (if reported) equals `version` (if given). Versioned
   * matches resolve immediately; unversioned ones settle first (see module
   * invariant). Resolves null on timeout/abort with no candidate. Never rejects.
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
    if (existing && matches(existing, probe) && existing.version !== undefined) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let candidate: PublishedDiagnostics | null = null;
      let settleTimer: NodeJS.Timeout | null = null;
      const finish = (v: PublishedDiagnostics | null) => {
        clearTimeout(timer);
        if (settleTimer) clearTimeout(settleTimer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(waiter);
        resolve(v);
      };
      const onAbort = () => finish(null);
      const offer = (p: PublishedDiagnostics) => {
        if (p.version !== undefined) return finish(p);
        if (!candidate || p.seq > candidate.seq) candidate = p;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish(candidate), this.settleMs);
        settleTimer.unref();
      };
      const waiter: Waiter = { ...probe, offer };
      const timer = setTimeout(() => finish(candidate), timeoutMs);
      timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
      if (existing && matches(existing, probe)) offer(existing);
    });
  }
}

function matches(entry: PublishedDiagnostics, w: Pick<Waiter, 'uri' | 'version' | 'afterSeq'>): boolean {
  if (entry.uri !== w.uri || entry.seq <= w.afterSeq) return false;
  return entry.version === undefined || w.version === undefined || entry.version === w.version;
}
