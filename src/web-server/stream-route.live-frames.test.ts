import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';
import { handleStream } from './stream-route.js';
import { parseSseChunk } from './sse-protocol.js';
import { LiveBroker } from './live-broker.js';
import type { OutputEvent } from '../agent/types/session-types.js';

const id = 'live-stream';
const record = (text: string) => JSON.stringify({ v: 1, ts: Date.now(), kind: 'assistant', text }) + '\n';
const text = (content: string): OutputEvent => ({ type: 'chunk', chunk: { type: 'content', content } });

function connect(live: LiveBroker, lastEventId?: string) {
  const req = Object.assign(new EventEmitter(), { headers: { ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } });
  let raw = '';
  const res = { writeHead: vi.fn(), flushHeaders: vi.fn(), write: (chunk: string) => { raw += chunk; }, end: vi.fn() };
  const done = handleStream(req as IncomingMessage, res as unknown as ServerResponse, id, undefined, undefined, live);
  return {
    done,
    frames: () => parseSseChunk(raw).events.map((e) => ({ id: e.id, data: JSON.parse(e.data) })),
    disconnect: () => req.emit('close'),
  };
}

beforeEach(() => {
  vi.stubEnv('AFK_STATE_DIR', mkdtempSync(join(tmpdir(), 'sse-live-')));
  mkdirSync(getSessionLedgerDir(id), { recursive: true });
});
afterEach(() => vi.unstubAllEnvs());

describe('handleStream live frames', () => {
  it('writes the open-segment snapshot after replay, then id-less deltas that never move the cursor', async () => {
    writeFileSync(getSessionLedgerPath(id), record('old answer'));
    const live = new LiveBroker(0);
    live.beginTurn(id);
    live.observe(id, text('Hel'));
    const tab = connect(live);
    try {
      await vi.waitFor(() => expect(tab.frames().some((f) => f.data.type === 'live_snapshot')).toBe(true));
      const frames = tab.frames();
      expect(frames[0]!.data.record.text).toBe('old answer');
      expect(frames[1]).toEqual({ id: undefined, data: { type: 'live_snapshot', turn: 1, seg: 0, part: 'text', text: 'Hel' } });
      live.observe(id, text('lo'));
      await vi.waitFor(() => expect(tab.frames().some((f) => f.data.type === 'live_delta')).toBe(true));
      const delta = tab.frames().find((f) => f.data.type === 'live_delta')!;
      expect(delta).toEqual({ id: undefined, data: { type: 'live_delta', turn: 1, seg: 0, part: 'text', offset: 3, text: 'lo' } });
      // The durable cursor is still the ledger frame's id.
      appendFileSync(getSessionLedgerPath(id), record('next'));
      await vi.waitFor(() => expect(tab.frames().filter((f) => f.id).length).toBe(2));
      const ids = tab.frames().filter((f) => f.id).map((f) => f.id!);
      expect(ids[1]!.split(':')[0]).toBe(ids[0]!.split(':')[0]);
    } finally { tab.disconnect(); await tab.done; live.cancelAll(); }
  });

  it('replays the snapshot after a ledger reset', async () => {
    writeFileSync(getSessionLedgerPath(id), record('old'));
    const live = new LiveBroker(0);
    const tab = connect(live);
    try {
      await vi.waitFor(() => expect(tab.frames()).toHaveLength(1));
      live.beginTurn(id);
      live.observe(id, text('streaming'));
      const file = getSessionLedgerPath(id);
      writeFileSync(`${file}.next`, record('new'));
      renameSync(`${file}.next`, file);
      await vi.waitFor(() => {
        const frames = tab.frames();
        const reset = frames.findIndex((f) => f.data.reset);
        expect(reset).toBeGreaterThan(0);
        expect(frames.slice(reset + 1).some((f) => f.data.type === 'live_snapshot' && f.data.text === 'streaming')).toBe(true);
      });
    } finally { tab.disconnect(); await tab.done; live.cancelAll(); }
  });
});
