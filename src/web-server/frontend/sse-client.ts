/**
 * Streaming client for /api/sessions/:id/stream.
 *
 * Invariant: this uses fetch + ReadableStream rather than the native
 * EventSource. EventSource cannot set request headers, which would force the
 * bearer token into the query string of a long-lived connection where it lands
 * in logs, referrers, and screen shares. The cost is that auto-reconnect and
 * Last-Event-ID must be implemented here rather than by the browser.
 */

import { parseSseChunk } from '../sse-protocol.js';

export interface StreamHandlers {
  onEvent: (data: unknown, meta: { id?: string }) => void;
  onStatus?: (status: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
}

const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

export class SessionStream {
  private controller: AbortController | undefined;
  private lastEventId: string | undefined;
  private attempt = 0;
  private stopped = false;

  constructor(
    private readonly sessionId: string,
    private readonly token: string,
    private readonly handlers: StreamHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.handlers.onStatus?.('closed');
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.handlers.onStatus?.(this.attempt === 0 ? 'connecting' : 'reconnecting');

    this.controller = new AbortController();
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    // Resume exactly where this client left off rather than replaying the whole
    // ledger on every reconnect.
    if (this.lastEventId !== undefined) headers['last-event-id'] = this.lastEventId;

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/stream`, {
        headers,
        signal: this.controller.signal,
      });
      if (!res.ok || res.body === null) throw new Error(`stream failed: ${res.status}`);

      this.attempt = 0;
      this.handlers.onStatus?.('open');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseChunk(buffer);
        buffer = remainder;
        for (const evt of events) {
          if (evt.id !== undefined) this.lastEventId = evt.id;
          if (evt.data === undefined) continue;
          try {
            this.handlers.onEvent(JSON.parse(evt.data) as unknown, { id: evt.id });
          } catch {
            // A single malformed frame must not tear down the stream.
          }
        }
      }
    } catch {
      // Fall through to reconnect.
    }

    if (this.stopped) return;
    this.attempt += 1;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (this.attempt - 1), MAX_BACKOFF_MS);
    setTimeout(() => void this.connect(), delay);
  }
}
