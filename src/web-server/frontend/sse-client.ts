/**
 * Streaming client for /api/sessions/:id/stream.
 *
 * Invariant: this uses fetch + ReadableStream rather than the native
 * EventSource. EventSource cannot set request headers, which would force the
 * bearer token into the query string of a long-lived connection where it lands
 * in logs, referrers, and screen shares. The cost is that auto-reconnect and
 * Last-Event-ID must be implemented here rather than by the browser.
 */

import { isSseEndFrame, parseSseChunk } from '../sse-protocol.js';

/**
 * Transport state, as distinct from session state.
 *
 * Contract: `closed` means THIS CLIENT stopped listening (an explicit `stop()`,
 * e.g. the operator selected another session); `ended` means the SESSION itself
 * reached a terminal record and will never emit again. They are reported
 * separately because only the second one is a fact about the agent — collapsing
 * them would make switching sessions look like a session ending.
 */
export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'ended';

export interface StreamHandlers {
  onEvent: (data: unknown, meta: { id?: string }) => void;
  onStatus?: (status: StreamStatus) => void;
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

    /** Set only by the terminal frame — distinguishes end-of-session from stop(). */
    let ended = false;

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

      reading: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseChunk(buffer);
        buffer = remainder;
        for (const evt of events) {
          if (evt.id !== undefined) this.lastEventId = evt.id;
          if (evt.data === undefined) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(evt.data) as unknown;
          } catch {
            // A single malformed frame must not tear down the stream.
            continue;
          }
          // Invariant: the terminal frame is checked BEFORE dispatch and is not
          // forwarded to `onEvent`. It carries no ledger record, so every
          // consumer would have to special-case it anyway; keeping it inside the
          // transport is what lets the app layer stay a pure record handler.
          if (isSseEndFrame(payload)) {
            ended = true;
            this.stopped = true;
            break reading;
          }
          this.handlers.onEvent(payload, { id: evt.id });
        }
      }
    } catch {
      // Fall through to reconnect.
    }

    // Invariant: `stopped` short-circuits the reconnect, and it is now set by
    // TWO things — an explicit `stop()` and the terminal frame above. Before the
    // frame existed, a session whose ledger hit its `closed` record ended the
    // response normally, `reader.read()` reported `done`, and this reschedule
    // fired unconditionally; because a successful fetch resets `attempt` to 0,
    // the delay stayed pinned at 500ms and never backed off. That was a
    // permanent 2-requests-per-second loop, each cycle re-reading and parsing
    // the whole ledger twice, against every ended session — reached with zero
    // clicks, since the app auto-selects the newest session on load.
    // `ended` is reported here and `closed` is not, because `stop()` already
    // emitted `closed` synchronously on the way in; re-emitting would fire the
    // same status twice for one transition.
    if (this.stopped) {
      if (ended) this.handlers.onStatus?.('ended');
      return;
    }
    this.attempt += 1;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (this.attempt - 1), MAX_BACKOFF_MS);
    setTimeout(() => void this.connect(), delay);
  }
}
