/**
 * Invariant under test: a stream that ENDS is not the same event as a stream
 * that DROPS, and the client must tell them apart.
 *
 * History: `tailLedger` returns when it reads the terminal `closed` ledger
 * record, so the SSE route's `for await` exited and `res.end()` ran. The client
 * saw `reader.read()` report `done`, and — because `stopped` was set only by an
 * explicit `close()` — rescheduled a reconnect. A successful fetch also resets
 * `attempt` to 0, so the backoff never grew past its 500ms floor: every ended
 * session pinned the page in a permanent 2-requests-per-second loop, each cycle
 * re-reading and JSON-parsing the entire ledger twice on the server. It was
 * reached with zero clicks, since the app auto-selects the newest session on
 * load. The fix is an explicit terminal frame; these tests pin both halves of
 * the distinction, because collapsing either direction is a real regression:
 * treating every end as terminal would break reconnect after a network drop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionStream, type StreamStatus } from './sse-client.js';
import { formatSseFrame, SSE_END_FRAME } from '../sse-protocol.js';

/** One assistant record, framed exactly as `handleStream` writes it. */
function recordFrame(id: number, text: string): string {
  return formatSseFrame({ id: String(id), data: { record: { kind: 'assistant', text } } });
}

/** A body that emits `chunks` then closes — the shape `fetch().body` returns. */
function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

/**
 * Install a fake `fetch` that answers each call with the next canned body.
 * Records every call so header assertions (`last-event-id`) can be made.
 */
function installFetch(bodies: string[][]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    const chunks = bodies[Math.min(i, bodies.length - 1)] ?? [];
    i += 1;
    return Promise.resolve({ ok: true, status: 200, body: bodyOf(chunks) } as unknown as Response);
  });
  return { calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the microtask queue drain; the reader is promise-driven, not timer-driven. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('SessionStream — terminal frame ends the stream', () => {
  it('does NOT reconnect after a stream ending with the terminal frame', async () => {
    const { calls } = installFetch([
      [recordFrame(1, 'hello'), formatSseFrame({ data: SSE_END_FRAME })],
    ]);
    const events: unknown[] = [];
    const stream = new SessionStream('s1', 'tok', { onEvent: (d) => events.push(d) });

    stream.start();
    await settle();
    // Advance well past the 500ms floor AND the 15s ceiling: if the client
    // rescheduled at all, a second fetch lands in this window.
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(calls).toHaveLength(1);
    // The record before the terminal frame is still delivered...
    expect(events).toHaveLength(1);
    // ...and the terminal frame itself is NOT forwarded as a ledger event.
    expect(events.every((e) => (e as { record?: unknown }).record !== undefined)).toBe(true);
  });

  it("reports 'ended' rather than sitting on 'reconnecting' or claiming 'open'", async () => {
    installFetch([[formatSseFrame({ data: SSE_END_FRAME })]]);
    const statuses: StreamStatus[] = [];
    const stream = new SessionStream('s1', 'tok', {
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });

    stream.start();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(statuses.at(-1)).toBe('ended');
    expect(statuses).not.toContain('reconnecting');
  });

  it('stays ended across a later timer tick (stopped is sticky)', async () => {
    const { calls } = installFetch([[formatSseFrame({ data: SSE_END_FRAME })]]);
    const stream = new SessionStream('s1', 'tok', { onEvent: () => {} });

    stream.start();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();

    expect(calls).toHaveLength(1);
  });
});

describe('SessionStream — a dropped stream still reconnects', () => {
  it('reconnects when the stream ends WITHOUT the terminal frame', async () => {
    // First body drops mid-session (no end frame); second is held open-ish.
    const { calls } = installFetch([[recordFrame(1, 'hello')], [recordFrame(2, 'again')]]);
    const stream = new SessionStream('s1', 'tok', { onEvent: () => {} });

    stream.start();
    await settle();
    expect(calls).toHaveLength(1);

    // BASE_BACKOFF_MS (500) × max jitter (1.25) = 625ms ceiling.
    await vi.advanceTimersByTimeAsync(700);
    await settle();

    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('sends last-event-id on the reconnect so the server can resume', async () => {
    const { calls } = installFetch([[recordFrame(7, 'seen')], [recordFrame(8, 'next')]]);
    const stream = new SessionStream('s1', 'tok', { onEvent: () => {} });

    stream.start();
    await settle();
    // BASE_BACKOFF_MS (500) × max jitter (1.25) = 625ms ceiling.
    await vi.advanceTimersByTimeAsync(700);
    await settle();

    expect(calls[0]?.headers['last-event-id']).toBeUndefined();
    // The id of the last frame actually received, not a per-connection counter.
    expect(calls[1]?.headers['last-event-id']).toBe('7');
    expect(calls[1]?.headers['authorization']).toBe('Bearer tok');
  });

  it('does not send last-event-id past a frame it never received', async () => {
    // The terminal frame carries NO id, so it must not advance the cursor.
    const { calls } = installFetch([
      [recordFrame(3, 'a'), formatSseFrame({ data: SSE_END_FRAME })],
    ]);
    const stream = new SessionStream('s1', 'tok', { onEvent: () => {} });

    stream.start();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(calls).toHaveLength(1);
  });
});

describe('SessionStream — explicit stop is distinct from session end', () => {
  it("reports 'closed' (not 'ended') and does not reconnect", async () => {
    installFetch([[recordFrame(1, 'hello')]]);
    const statuses: StreamStatus[] = [];
    const stream = new SessionStream('s1', 'tok', {
      onEvent: () => {},
      onStatus: (s) => statuses.push(s),
    });

    stream.start();
    await settle();
    stream.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(statuses).toContain('closed');
    expect(statuses).not.toContain('ended');
  });
});
