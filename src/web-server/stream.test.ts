/**
 * Regression tests for the SSE stream route (`handleStream`).
 *
 * History: `handleStream` shipped with no test at all — nothing in the original
 * PR matched `last-event-id`, `tailLedger`, `reconnect`, `resume`, or
 * `disconnect`. Three defects lived in that gap and are pinned here:
 *
 *   1. Replay ran `readLedger` to EOF and then started `tailLedger` with its
 *      default offset, which re-stat'd the file. A record appended between the
 *      two was dropped.
 *   2. The SSE id was a per-connection emit counter rather than a ledger
 *      position, so a dropped record's true position stayed `<= resumeFrom`
 *      forever (permanently unreachable) while every later id sat one below its
 *      true position (re-sending a record the client had already displayed).
 *   3. `tailLedger` was called with no AbortSignal, so a disconnected client
 *      left a poll timer and an `fs.watch` handle running for the life of the
 *      process — and because the response never ended, `server.close()` never
 *      completed, which hung SIGINT.
 *
 * Isolation: AFK_HOME is redirected to a fresh temp dir per test, the same
 * idiom as `session-source.test.ts`, so ledger fixtures never touch real state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startWebServer, type WebServerHandle } from './server.js';
import { getSessionsDir } from '../paths.js';
import { parseSseChunk } from './sse-protocol.js';

let tmpDir: string;
let origAfkHome: string | undefined;
let handle: WebServerHandle | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-webstream-test-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpDir;
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = origAfkHome;
});

const SESSION = 'stream-fixture-session';

function ledgerPath(sessionId = SESSION): string {
  return path.join(getSessionsDir(), sessionId, 'events.jsonl');
}

/** Append one assistant record, the simplest well-formed ledger payload. */
function appendRecord(text: string, sessionId = SESSION): void {
  const file = ledgerPath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, ts: Date.now(), kind: 'assistant', text })}\n`);
}

interface Frame {
  id: string | undefined;
  text: string;
  replay: boolean;
}

/**
 * Read SSE frames until `want` of them arrive or the deadline passes, then
 * abort. Returns the decoded frames. Deliberately does not wait for the stream
 * to end: a tail over a session that is still OPEN never ends on its own. A
 * session whose ledger has reached its terminal `closed` record does end, and
 * emits the end frame — see `readUntilEnd` and the terminal-frame suite below.
 */
async function readFrames(
  h: WebServerHandle,
  want: number,
  opts: { lastEventId?: string; timeoutMs?: number } = {},
): Promise<Frame[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  const headers: Record<string, string> = { authorization: `Bearer ${h.token}` };
  if (opts.lastEventId !== undefined) headers['last-event-id'] = opts.lastEventId;

  const frames: Frame[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/sessions/${SESSION}/stream`, {
      headers,
      signal: controller.signal,
    });
    if (res.body === null) return frames;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (frames.length < want) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSseChunk(buffer);
      buffer = remainder;
      for (const evt of events) {
        const parsed = JSON.parse(evt.data) as {
          record?: { text?: string };
          replay?: boolean;
        };
        if (parsed.record === undefined) continue;
        frames.push({
          id: evt.id,
          text: parsed.record.text ?? '',
          replay: parsed.replay === true,
        });
      }
    }
  } catch {
    // Abort on deadline or on satisfying `want` is the normal exit path.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return frames;
}

describe('handleStream — event ids are ledger positions', () => {
  it('numbers replayed records by their 1-based position in the ledger', async () => {
    appendRecord('one');
    appendRecord('two');
    appendRecord('three');
    handle = await startWebServer({ port: 0 });

    const frames = await readFrames(handle, 3);
    expect(frames.map((f) => f.text)).toEqual(['one', 'two', 'three']);
    expect(frames.map((f) => f.id)).toEqual(['1', '2', '3']);
    // History is replay; the ledger never persists successful tool output, and
    // the frontend keys `outputUnavailable` off this flag.
    expect(frames.every((f) => f.replay)).toBe(true);
  });

  it('resumes from Last-Event-ID without re-sending seen records', async () => {
    appendRecord('one');
    appendRecord('two');
    appendRecord('three');
    handle = await startWebServer({ port: 0 });

    const frames = await readFrames(handle, 1, { lastEventId: '2' });
    expect(frames.map((f) => f.text)).toEqual(['three']);
    // The id must still be the true ledger position, not a per-connection
    // counter restarting at 1 — that drift is what made resume lose records.
    expect(frames[0]?.id).toBe('3');
  });

  it('delivers a record appended after replay drains, as live and unduplicated', async () => {
    appendRecord('one');
    handle = await startWebServer({ port: 0 });

    // One replayed record, then one written while the tail is live. The old
    // two-phase reader stat'd the file between these and dropped the second.
    const framesPromise = readFrames(handle, 2);
    await new Promise((r) => setTimeout(r, 150));
    appendRecord('two');

    const frames = await framesPromise;
    expect(frames.map((f) => f.text)).toEqual(['one', 'two']);
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
    expect(frames[0]?.replay).toBe(true);
    expect(frames[1]?.replay).toBe(false);
  });

  it('does not replay a record twice across a reconnect', async () => {
    appendRecord('one');
    handle = await startWebServer({ port: 0 });

    const first = await readFrames(handle, 1);
    expect(first.map((f) => f.id)).toEqual(['1']);

    appendRecord('two');
    const second = await readFrames(handle, 1, { lastEventId: first[0]?.id ?? '0' });
    expect(second.map((f) => f.text)).toEqual(['two']);
    expect(second.map((f) => f.id)).toEqual(['2']);
  });
});

/** Append the terminal `closed` record that makes `tailLedger` return. */
function appendClosed(sessionId = SESSION): void {
  const file = ledgerPath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, ts: Date.now(), kind: 'closed' })}\n`);
}

/**
 * Read a stream to its natural EOF (no abort), returning every decoded payload.
 * Only safe against a session that will actually end — hence the deadline.
 */
async function readUntilEnd(
  h: WebServerHandle,
  timeoutMs = 3000,
): Promise<{ payloads: unknown[]; endedNaturally: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const payloads: unknown[] = [];
  let endedNaturally = false;
  try {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/sessions/${SESSION}/stream`, {
      headers: { authorization: `Bearer ${h.token}` },
      signal: controller.signal,
    });
    if (res.body === null) return { payloads, endedNaturally };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        endedNaturally = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSseChunk(buffer);
      buffer = remainder;
      for (const evt of events) payloads.push(JSON.parse(evt.data) as unknown);
    }
  } catch {
    // Deadline abort — endedNaturally stays false, which is the assertion.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { payloads, endedNaturally };
}

/**
 * Invariant: a session that has ENDED must say so on the wire. Without this
 * frame the response simply closed, which is byte-identical to a network drop
 * from the browser's side — so the client reconnected, every 500ms, forever
 * (a successful fetch resets its backoff), re-reading the whole ledger twice
 * per cycle. The frame is what makes the two distinguishable.
 */
describe('handleStream — terminal frame on a closed session', () => {
  it('emits an end frame after the ledger reaches its closed record', async () => {
    appendRecord('one');
    appendClosed();
    handle = await startWebServer({ port: 0 });

    const { payloads, endedNaturally } = await readUntilEnd(handle);
    expect(endedNaturally).toBe(true);
    expect(payloads.at(-1)).toEqual({ end: true, reason: 'session_closed' });
  });

  it('carries no id, so it cannot advance a resuming client past a real record', async () => {
    appendRecord('one');
    appendClosed();
    handle = await startWebServer({ port: 0 });

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${SESSION}/stream`, {
      headers: { authorization: `Bearer ${handle.token}` },
      signal: controller.signal,
    });
    const text = await res.text();
    const { events } = parseSseChunk(text);
    const endEvent = events.find((e) => (JSON.parse(e.data) as { end?: boolean }).end === true);
    expect(endEvent).toBeDefined();
    expect(endEvent?.id).toBeUndefined();
    controller.abort();
  });

  it('does NOT emit an end frame to a client that merely disconnected', async () => {
    // No `closed` record: this session is still open, so the only way this
    // stream ends is the client going away — which must never be reported as a
    // session end (that would stop a real browser from ever reconnecting).
    appendRecord('one');
    handle = await startWebServer({ port: 0 });

    const frames = await readFrames(handle, 1, { timeoutMs: 500 });
    expect(frames.map((f) => f.text)).toEqual(['one']);

    const { endedNaturally } = await readUntilEnd(handle, 700);
    expect(endedNaturally).toBe(false);
  });
});

describe('handleStream — lifecycle', () => {
  it('stops promptly while a browser stream is open', async () => {
    appendRecord('one');
    handle = await startWebServer({ port: 0 });

    // Hold a stream open against a session that will never write again — the
    // exact shape that previously wedged shutdown, because tailLedger had no
    // abort signal and the response therefore never ended.
    const controller = new AbortController();
    const streaming = fetch(`http://127.0.0.1:${handle.port}/api/sessions/${SESSION}/stream`, {
      headers: { authorization: `Bearer ${handle.token}` },
      signal: controller.signal,
    }).then(async (res) => {
      await res.body?.getReader().read();
    });
    await new Promise((r) => setTimeout(r, 150));

    const started = Date.now();
    await handle.stop();
    const elapsed = Date.now() - started;
    handle = undefined;

    expect(elapsed).toBeLessThan(2000);
    controller.abort();
    await streaming.catch(() => {});
  });
});
