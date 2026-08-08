/**
 * Server-Sent-Events wire format — pure, DOM-free framing logic shared by
 * `afk web`'s HTTP server (`server.ts`, writer) and the browser frontend
 * bundle (`frontend/sse-client.ts`, parser). Single source of truth for the
 * wire format so server and client can never drift on how a frame is
 * delimited.
 *
 * Deliberately NOT built on the native `EventSource` API: `EventSource`
 * cannot send a bearer-token `Authorization` header (only URL query params,
 * which land in logs/history), so the frontend hand-rolls a
 * `fetch` + `ReadableStream` reader and feeds raw chunks through
 * {@link parseSseChunk}. That reuse is the reason this module has zero DOM
 * dependencies: it operates on plain strings only.
 *
 * Frame shape (standard SSE, minimal subset):
 *   id: <event id>        (optional)
 *   data: <json line>     (always present; JSON is single-line — see
 *                           formatSseFrame — so no multi-line `data:` framing
 *                           is needed)
 *   <blank line>           (frame terminator)
 *
 * @module web-server/sse-protocol
 */

import { jsonDateReplacer } from '../cli/json-date-replacer.js';

/** One SSE frame to write to the wire. */
export interface SseFrame {
  /** Optional event id — becomes the `Last-Event-ID` a reconnecting client sends back. */
  id?: string;
  /** Payload. JSON-stringified with {@link jsonDateReplacer} (Date → ISO, Error → {message,name}). */
  data: unknown;
}

/** One SSE frame parsed back out of a raw byte/text stream. */
export interface ParsedSseEvent {
  /** The frame's `id:` field, or `undefined` if it carried none. */
  id: string | undefined;
  /** Raw (still-JSON-encoded) payload text — the parsed `data:` line content. */
  data: string;
}

/**
 * Format one frame for the wire. Always ends with a blank-line terminator
 * (`\n\n`) so consecutive frames concatenate safely without an explicit
 * flush boundary between calls.
 *
 * The JSON payload is guaranteed single-line: `JSON.stringify` never emits a
 * bare `\n` in its output (newlines inside string values are escaped as
 * `\\n`), so the `data:` line is always exactly one line — no multi-line
 * `data:` continuation framing is required on read-back.
 */
export function formatSseFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) {
    lines.push(`id: ${frame.id}`);
  }
  lines.push(`data: ${JSON.stringify(frame.data, jsonDateReplacer)}`);
  return lines.join('\n') + '\n\n';
}

/**
 * Payload of the frame the server writes when a session has genuinely ENDED
 * (its ledger reached a terminal `closed` record and the tail returned).
 *
 * Invariant: this frame carries NO `id:`. Every other frame's id is the
 * record's 1-based position in the ledger file, which is what `Last-Event-ID`
 * resume is computed against; giving a non-record frame an id would either
 * duplicate a real position or push the client's cursor past a record it never
 * received. It is also the reason the marker lives here rather than being
 * spelled out at each end: writer and reader must agree on it exactly, and the
 * client's only alternative signal — the socket closing — is indistinguishable
 * from a network drop, which is precisely the ambiguity that pinned the page in
 * a 500ms reconnect loop against every ended session.
 */
export interface SseEndFrame {
  end: true;
  reason: string;
}

/** The single terminal frame payload; see {@link SseEndFrame}. */
export const SSE_END_FRAME: SseEndFrame = Object.freeze({
  end: true,
  reason: 'session_closed',
});

/** Whether a decoded frame payload is the terminal end-of-session marker. */
export function isSseEndFrame(payload: unknown): payload is SseEndFrame {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { end?: unknown }).end === true
  );
}

/** Result of parsing a (possibly partial) SSE text buffer. */
export interface ParseSseChunkResult {
  /** Fully-terminated frames found in `buffer`, in arrival order. */
  events: ParsedSseEvent[];
  /** Trailing partial frame text (no blank-line terminator yet) — feed back in on the next chunk. */
  remainder: string;
}

/**
 * Parse a text buffer (the concatenation of `remainder` from the previous
 * call plus a newly-arrived chunk) into complete SSE frames plus whatever
 * incomplete trailing text remains.
 *
 * Frames are delimited by a blank line (`\n\n`, or `\r\n\r\n` — CRLF is
 * normalized before splitting). A frame missing a `data:` line is skipped
 * (defensive: a comment-only `:` keepalive ping, or malformed input, must
 * never crash the reader).
 */
export function parseSseChunk(buffer: string): ParseSseChunkResult {
  // Normalize CRLF to LF up front so the terminator search below is a single
  // pattern regardless of how the transport line-ended the stream.
  const normalized = buffer.replace(/\r\n/g, '\n');
  const rawFrames = normalized.split('\n\n');
  // The last element is either '' (buffer ended exactly on a terminator) or a
  // partial frame with no terminator yet — either way it is NOT a complete
  // frame and must be held back as `remainder`.
  const remainder = rawFrames.pop() ?? '';

  const events: ParsedSseEvent[] = [];
  for (const rawFrame of rawFrames) {
    if (rawFrame.trim() === '') continue; // keepalive blank / comment-only frame
    let id: string | undefined;
    let data: string | undefined;
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith('id: ')) {
        id = line.slice('id: '.length);
      } else if (line.startsWith('id:')) {
        id = line.slice('id:'.length).trimStart();
      } else if (line.startsWith('data: ')) {
        data = line.slice('data: '.length);
      } else if (line.startsWith('data:')) {
        data = line.slice('data:'.length).trimStart();
      }
      // Any other line (e.g. a `:` comment/keepalive line) is ignored.
    }
    if (data !== undefined) {
      events.push({ id, data });
    }
  }

  return { events, remainder };
}
