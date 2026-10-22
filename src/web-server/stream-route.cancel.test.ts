import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';
import { handleStream } from './stream-route.js';
import { parseSseChunk } from './sse-protocol.js';
import { ChoiceBroker } from './choice-broker.js';

const id = 'cancel-stream';
const record = (text: string) => JSON.stringify({ v: 1, ts: Date.now(), kind: 'assistant', text }) + '\n';
const closed = () => JSON.stringify({ v: 1, ts: Date.now(), kind: 'closed', reason: 'done' }) + '\n';

function connect(choices?: ChoiceBroker) {
  const req = Object.assign(new EventEmitter(), { headers: {} });
  let raw = '';
  const res = { writeHead: vi.fn(), flushHeaders: vi.fn(), write: (chunk: string) => { raw += chunk; }, end: vi.fn() };
  const done = handleStream(req as IncomingMessage, res as unknown as ServerResponse, id, undefined, choices);
  return {
    res, done,
    frames: () => parseSseChunk(raw).events.map((e) => ({ id: e.id, data: JSON.parse(e.data) })),
    disconnect: () => req.emit('close'),
  };
}

beforeEach(() => {
  vi.stubEnv('AFK_STATE_DIR', mkdtempSync(join(tmpdir(), 'sse-cancel-')));
  mkdirSync(getSessionLedgerDir(id), { recursive: true });
});
afterEach(() => vi.unstubAllEnvs());

describe('stream-route cancelSession', () => {
  it('does not cancel pending choices on the normal tail-end path (only via unsubscribe)', async () => {
    // Before the fix, `choices.cancelSession(sessionId)` was called explicitly
    // in the tail-end block before writing SSE_END_FRAME. After the fix, the
    // only path that calls cancelSession is the unsubscribe closure (last-
    // subscriber disconnect). This test verifies the explicit call is gone by
    // checking the SSE frames: the end frame must appear WITHOUT a preceding
    // choice_settled frame from a spurious cancelSession.
    writeFileSync(getSessionLedgerPath(id), record('hello') + closed());
    const choices = new ChoiceBroker();
    const req = { corrId: 'active', title: 'Pick', options: [{ value: 'yes', label: 'Yes' }], cancellable: true };
    choices.choose(id, req);
    // Subscribe a second listener so the stream's own unsubscribe does not
    // trigger last-subscriber cancellation — isolating the explicit call.
    const extra = vi.fn();
    const detach = choices.subscribe(id, extra);
    const tab = connect(choices);
    await tab.done;
    const frames = tab.frames();
    // The end frame should be present and no choice_settled should precede it
    // (the old code would have settled the choice before the end frame).
    const endIdx = frames.findIndex((f) => f.data.end);
    expect(endIdx).toBeGreaterThanOrEqual(0);
    const settledBefore = frames.slice(0, endIdx).filter((f) => f.data.type === 'choice_settled');
    expect(settledBefore).toHaveLength(0);
    // The choice is still answerable because the extra subscriber kept it alive.
    expect(choices.answer(id, 'active', 'yes')).toBe('answered');
    detach();
    choices.cancelAll();
  });

  it('cancels pending choices on client disconnect via unsubscribe', async () => {
    writeFileSync(getSessionLedgerPath(id), record('hello'));
    const choices = new ChoiceBroker();
    const req = { corrId: 'active', title: 'Pick', options: [{ value: 'yes', label: 'Yes' }], cancellable: true };
    const answer = choices.choose(id, req);
    const tab = connect(choices);
    await vi.waitFor(() => expect(tab.frames()).toHaveLength(1));
    tab.disconnect();
    await tab.done;
    // Disconnect triggers unsubscribe → cancelSession (last subscriber).
    expect(await answer).toBeNull();
  });
});
