/**
 * Per-client open-document bookkeeping: first touch -> `didOpen`, later
 * touches -> `didChange` (full text, version++) only when content changed.
 *
 * @module agent/lsp/document-sync
 */

/** Notification the client should send for a sync, or null when unchanged. */
export interface SyncNotification {
  readonly method: 'textDocument/didOpen' | 'textDocument/didChange';
  readonly params: unknown;
}

export interface SyncResult {
  readonly version: number;
  /** True when a didOpen/didChange was produced (diagnostics will be republished). */
  readonly changed: boolean;
  readonly notification: SyncNotification | null;
}

interface DocState { version: number; text: string }

export class DocumentSync {
  private readonly docs = new Map<string, DocState>();

  /** Current version for `uri`, or undefined when never opened. */
  version(uri: string): number | undefined {
    return this.docs.get(uri)?.version;
  }

  /** Uris currently open (tests / diagnostics). */
  openUris(): string[] {
    return [...this.docs.keys()];
  }

  /**
   * Forget every open document not in `keep` and return the didClose
   * notifications to send. A closed document is re-opened (didOpen, fresh
   * text from disk) on its next sync, so the server never keeps a stale
   * in-memory copy of a file edited by another route (#4293 review C-2),
   * and open-document state stays bounded to one file per server (C-6).
   */
  closeAllExcept(keep: ReadonlySet<string>): Array<{ readonly method: 'textDocument/didClose'; readonly params: unknown }> {
    const out: Array<{ readonly method: 'textDocument/didClose'; readonly params: unknown }> = [];
    for (const uri of [...this.docs.keys()]) {
      if (keep.has(uri)) continue;
      this.docs.delete(uri);
      out.push({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
    }
    return out;
  }

  /** Compute the sync notification for `text` and record the new state. */
  sync(uri: string, languageId: string, text: string): SyncResult {
    const prev = this.docs.get(uri);
    if (!prev) {
      this.docs.set(uri, { version: 1, text });
      return {
        version: 1,
        changed: true,
        notification: {
          method: 'textDocument/didOpen',
          params: { textDocument: { uri, languageId, version: 1, text } },
        },
      };
    }
    if (prev.text === text) return { version: prev.version, changed: false, notification: null };
    const version = prev.version + 1;
    this.docs.set(uri, { version, text });
    return {
      version,
      changed: true,
      notification: {
        method: 'textDocument/didChange',
        params: { textDocument: { uri, version }, contentChanges: [{ text }] },
      },
    };
  }
}
