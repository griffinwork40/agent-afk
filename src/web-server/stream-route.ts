/**
 * `GET /api/sessions/:id/stream` — the SSE transport for a live session.
 *
 * Extracted from `routes.ts` to keep every source file under the 350-line
 * ceiling; this is the whole streaming concern, moved verbatim.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readLedger, tailLedger } from '../agent/session-ledger.js';
import { formatSseFrame } from './sse-protocol.js';
import { header, requireValidSessionId, SECURITY_HEADERS } from './routes.js';

/** Heartbeat cadence; keeps intermediaries from idling out a quiet stream. */
const HEARTBEAT_MS = 15_000;

/**
 * Invariant: SSE resume is replay-then-tail, and the replay source is the
 * session LEDGER, which is a lossy projection rather than a transcript
 * (assistant text capped, tool inputs truncated, and successful tool output
 * never persisted at all). The `replay: true` marker on replayed frames is what
 * lets the browser render "result not available after refresh" instead of
 * presenting an empty string as though it were the real output. Dropping that
 * flag would silently turn a known gap into a confident lie.
 */
export async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  streams?: Set<AbortController>,
): Promise<void> {
  // Invariant: validate BEFORE writing the 200 head. Once the event-stream
  // header is sent the status can no longer be changed, so the 400 has to
  // happen here or not at all.
  if (!requireValidSessionId(res, sessionId)) return;

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Defeats proxy buffering, which otherwise holds frames until a buffer
    // fills and makes a live stream look hung.
    'x-accel-buffering': 'no',
  });

  const lastEventId = header(req, 'last-event-id');
  let seq = Number.parseInt(lastEventId ?? '0', 10);
  if (!Number.isFinite(seq) || seq < 0) seq = 0;
  const resumeFrom = seq;

  // Invariant: the SSE event id is the record's 1-based POSITION IN THE LEDGER
  // FILE, never a per-connection emit counter. `Last-Event-ID` resume is
  // implemented as `position <= resumeFrom -> skip`, so the id must mean the
  // same thing on every connection. A counter that advanced only on emitted
  // records made a single missed record permanently unreachable (its true
  // position stayed <= resumeFrom forever) and simultaneously re-sent an
  // already-seen record, because every later id sat one below its true
  // position.
  //
  // Invariant: the tail is aborted through `controller`, and that abort is the
  // ONLY thing that can stop `tailLedger`. Its loop guard is
  // `while (!signal?.aborted && !sawClosed)`, so without a signal the sole exit
  // was a terminal `closed` record: a client that disconnected from a quiet
  // session leaked a 250ms poll timer plus an `fs.watch` handle for the life of
  // the process, and because the response never ended, `server.close()` never
  // completed either. The consumer-side `closed` check cannot substitute — it
  // only runs once the generator yields, which a quiet session never does.
  const controller = new AbortController();
  streams?.add(controller);

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
    streams?.delete(controller);
    res.end();
  };
  req.on('close', finish);

  try {
    // Phase 1 — replay the history that exists right now, tracking how many
    // records that was so the live phase can pick up at exactly that position.
    let replayCount = 0;
    for await (const record of readLedger(sessionId)) {
      replayCount += 1;
      if (replayCount <= resumeFrom) continue;
      if (closed) return;
      res.write(formatSseFrame({ id: String(replayCount), data: { record, replay: true } }));
    }

    // Phase 2 — tail from the START of the file, skipping the records phase 1
    // already accounted for.
    //
    // Invariant: `fromStart: true` is what closes the replay-to-tail gap. The
    // default (`fromStart: false`) re-stats the file and begins at whatever EOF
    // happens to be at that instant, so any record appended after phase 1
    // drained but before that stat was dropped — silently, and permanently once
    // the positional id advanced past it. Re-reading from offset 0 with one
    // continuous cursor cannot skip a record; a record written during the
    // handoff simply lands past `replayCount` and is emitted live, which is
    // what it is. The cost is one extra sequential read of an append-only file.
    let position = 0;
    for await (const record of tailLedger(sessionId, {
      fromStart: true,
      signal: controller.signal,
    })) {
      position += 1;
      // Already delivered (or deliberately skipped) during replay.
      if (position <= replayCount || position <= resumeFrom) continue;
      if (closed) return;
      res.write(formatSseFrame({ id: String(position), data: { record, replay: false } }));
    }
  } catch (err) {
    if (!closed) {
      res.write(
        formatSseFrame({
          data: { error: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  } finally {
    finish();
  }
}

