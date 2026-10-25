/** GET /api/sessions/:id/stream — generation-aware durable ledger SSE. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tailLedger } from '../agent/session-ledger.js';
import { formatSseFrame, SSE_END_FRAME } from './sse-protocol.js';
import { header, requireValidSessionId, SECURITY_HEADERS } from './routes.js';
import { errorMessage } from '../utils/errors.js';
import type { ChoiceBroker } from './choice-broker.js';
import type { ChoiceSsePayload } from './shared/choice-wire.js';
import type { LiveBroker } from './live-broker.js';
import type { LiveSsePayload } from './shared/live-wire.js';

const HEARTBEAT_MS = 15_000;

/** IDs qualify the 1-based ledger position with its inode generation. A clear
 * atomically replaces the file, so old reconnect cursors can never skip new
 * records. One reader handles replay + tail (no handoff race). Reset seals are
 * nonterminal; other tabs receive reset before any replacement-generation data.
 */
export async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  streams?: Set<AbortController>,
  choices?: ChoiceBroker,
  live?: LiveBroker,
): Promise<void> {
  if (!requireValidSessionId(res, sessionId)) return;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();

  // Old unqualified cursors cannot identify a generation. Safely replay rather
  // than silently dropping records after a clear (legacy upgrade only).
  const cursor = /^(\d+-\d+(?:-\d+)?):(\d+)$/.exec(header(req, 'last-event-id') ?? '');
  const cursorGeneration = cursor?.[1];
  const cursorPosition = Number(cursor?.[2] ?? 0);
  let generation: string | undefined;
  let position = 0;
  let replay = true;
  const controller = new AbortController();
  streams?.add(controller);
  let closed = false;
  // Id-less ephemeral notifications never advance the durable ledger cursor.
  const writeChoice = (event: ChoiceSsePayload): void => {
    if (!closed) res.write(formatSseFrame({ data: event }));
  };
  const unsubscribe = choices?.subscribe(sessionId, writeChoice);
  // Invariant: live text frames are id-less and held back until the durable
  // replay has caught up, then a snapshot of the OPEN segments is written.
  // Sending them earlier would let replayed older-turn `assistant{seg}`
  // records match (and replace) the current turn's drafts. Sealed segments
  // need no live copy: their durable records are already in the ledger tail.
  let liveReady = false;
  const writeLive = (event: LiveSsePayload): void => {
    if (!closed && liveReady) res.write(formatSseFrame({ data: event }));
  };
  const writeLiveSnapshot = (): void => {
    if (!live) return;
    for (const frame of live.snapshot(sessionId)) writeLive(frame);
  };
  const unsubscribeLive = live?.subscribe(sessionId, writeLive);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
    streams?.delete(controller);
    unsubscribe?.();
    unsubscribeLive?.();
    res.end();
  };
  req.on('close', finish);

  try {
    for await (const record of tailLedger(sessionId, {
      fromStart: true,
      signal: controller.signal,
      onCaughtUp: () => {
        replay = false;
        liveReady = true;
        writeLiveSnapshot();
      },
      onGeneration: (next) => {
        const changed = generation !== undefined;
        const staleCursor = cursorGeneration !== undefined && cursorGeneration !== next;
        if (!closed && (changed || staleCursor)) {
          res.write(formatSseFrame({ data: { reset: true } }));
          // Subscription must precede replay to avoid losing live requests,
          // but its initial snapshot may now have been erased by this reset.
          choices?.replayPending(sessionId, writeChoice);
          // The client dropped its drafts on reset; rebuild open segments.
          writeLiveSnapshot();
        }
        generation = next;
        position = 0;
      },
    })) {
      position += 1;
      if (generation === cursorGeneration && position <= cursorPosition) continue;
      if (closed) return;
      // replay:true is load-bearing: ledger tool results are lossy, not a
      // substitute for the full original result available only in live memory.
      res.write(formatSseFrame({ id: `${generation}:${position}`, data: { record, replay } }));
    }
    if (!closed && !controller.signal.aborted) {
      res.write(formatSseFrame({ data: SSE_END_FRAME }));
    }
  } catch (err) {
    if (!closed) res.write(formatSseFrame({ data: { error: errorMessage(err) } }));
  } finally {
    finish();
  }
}
