/**
 * `seal(payload, pendingWrites)` contract (#3714 follow-up to #3807).
 *
 * 1. Bounded: a pending child terminal write that never settles (wedged
 *    child trace sink) must not hang `seal()` — and therefore session
 *    shutdown and process exit. After `SEAL_PENDING_WRITES_TIMEOUT_MS` the
 *    seal proceeds, warns on stderr naming how many writes were abandoned,
 *    and STILL writes `session_sealed`.
 * 2. Delivering: a pending write whose `write()` call reaches the writer only
 *    AFTER `seal()` was entered (the async-sink case #3714 is about) must land
 *    ahead of `session_sealed` — for BOTH writer implementations. Before this
 *    fix the in-memory writer rejected it (sealed flag set first) and the
 *    NDJSON writer deadlocked (the write queued behind the seal task that was
 *    awaiting it).
 *
 * Deterministic: deferred promises gate arrival; fake timers drive the bound.
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitSubagentLifecycle } from './emit.js';
import { SEAL_PENDING_WRITES_TIMEOUT_MS } from './pending-writes.js';
import { InMemoryTraceWriter, NdjsonTraceWriter, type TraceWriter } from './writer.js';
import type { TraceEvent, TraceEventInput } from './types.js';
import { SUBAGENT_DRAIN_TIMEOUT_MS } from '../subagent/constants.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const SEAL = {
  status: 'cancelled' as const,
  finalCostUsd: 0,
  finalTurnCount: 1,
  closedAt: '2026-10-15T00:00:00.000Z',
};

const STARTED: TraceEventInput = {
  kind: 'subagent_lifecycle',
  payload: { transition: 'started', subagentId: 'child', parentId: 'parent', model: 'sonnet' },
};

type Kind = 'ndjson' | 'memory';
let dir: string;

async function makeWriter(kind: Kind): Promise<TraceWriter> {
  if (kind === 'memory') return new InMemoryTraceWriter();
  return new NdjsonTraceWriter({ traceDir: dir });
}

async function rows(kind: Kind, writer: TraceWriter): Promise<TraceEvent[]> {
  if (kind === 'memory') return [...(writer as InMemoryTraceWriter).events];
  const text = await readFile(writer.getTracePath(), 'utf8');
  return text.trim().split('\n').map((l) => JSON.parse(l) as TraceEvent);
}

function isCancelled(e: TraceEvent): boolean {
  return e.kind === 'subagent_lifecycle' &&
    (e.payload as { transition?: string }).transition === 'cancelled';
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'afk-seal-pending-'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('seal bound matches the subagent drain bound', () => {
  expect(SEAL_PENDING_WRITES_TIMEOUT_MS).toBe(SUBAGENT_DRAIN_TIMEOUT_MS);
});

for (const kind of ['ndjson', 'memory'] as const) {
  describe(`${kind} writer seal(pendingWrites)`, () => {
    it('lands a child cancelled row whose write() arrives after seal() began', async () => {
      const writer = await makeWriter(kind);
      await writer.write(STARTED);
      const gate = deferred();
      // Async child sink: the cancelled emit reaches the writer only after
      // the gate opens, which happens after seal() is already in flight.
      const lateSink = {
        getTracePath: () => writer.getTracePath(),
        async write(event: TraceEventInput) {
          await gate.promise;
          await writer.write(event);
        },
      };
      const pending = emitSubagentLifecycle(lateSink, {
        transition: 'cancelled', subagentId: 'child', source: 'explicit',
      });
      const sealing = writer.seal(SEAL, [pending]);
      gate.resolve();
      await sealing;
      const out = await rows(kind, writer);
      expect(out.some(isCancelled)).toBe(true);
      expect(out.findIndex(isCancelled)).toBeLessThan(out.findIndex((e) => e.kind === 'session_sealed'));
      expect(out.at(-1)?.kind).toBe('session_sealed');
      expect(out.filter((e) => e.kind === 'session_sealed')).toHaveLength(1);
      await writer.close();
    }, 2_000);

    it('a never-settling pending write cannot hang seal; session_sealed is still written', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const writer = await makeWriter(kind);
      await writer.write(STARTED);
      const wedged = new Promise<void>(() => {});
      const settled = Promise.resolve();
      let done = false;
      const sealing = writer.seal(SEAL, [wedged, settled]).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(SEAL_PENDING_WRITES_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await sealing;
      expect(done).toBe(true);
      const out = await rows(kind, writer);
      expect(out.at(-1)?.kind).toBe('session_sealed');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/abandoned 1 of 2 pending/);
      // The writer is terminal after the bounded seal.
      await expect(writer.write(STARTED)).rejects.toThrow(/sealed/);
      await writer.close();
    }, 2_000);

    it('no warning and no lingering timer when every pending write settles', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const writer = await makeWriter(kind);
      await writer.write(STARTED);
      await writer.seal(SEAL, [Promise.resolve(), Promise.reject(new Error('emit failed'))]);
      expect(vi.getTimerCount()).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      expect((await rows(kind, writer)).at(-1)?.kind).toBe('session_sealed');
      await writer.close();
    }, 2_000);

    it('concurrent seal() calls during the pending window write exactly one seal record', async () => {
      const writer = await makeWriter(kind);
      await writer.write(STARTED);
      const gate = deferred();
      const first = writer.seal(SEAL, [gate.promise]);
      const second = writer.seal(SEAL);
      gate.resolve();
      await Promise.all([first, second]);
      const out = await rows(kind, writer);
      expect(out.filter((e) => e.kind === 'session_sealed')).toHaveLength(1);
      await writer.close();
    }, 2_000);
  });
}
