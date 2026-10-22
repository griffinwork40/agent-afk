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
