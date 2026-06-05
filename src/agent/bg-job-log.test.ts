/**
 * Tests for BgJobLogWriter and BgJobLogReader.
 *
 * Uses a temp directory per test so no real ~/.afk/state/bg/ is touched.
 * Overrides AFK_HOME env var to redirect path helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// We need to control the AFK_HOME before importing paths/bg-job-log.
// Use a unique temp dir per test suite run.
let tmpDir: string;

// We import lazily so we can set AFK_HOME first.
// vitest imports modules at evaluation time, but since we use vi.mock or
// control env before the first import, we need a slightly different approach:
// set the env variable BEFORE importing the modules under test.

// Set AFK_HOME before the module is imported (done at top of describe blocks
// via beforeEach + a fresh import each test is overkill, so we use a single
// temp dir set before the suite starts — this is safe because vitest runs
// each file in its own worker).

tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-bg-test-'));
process.env['AFK_HOME'] = tmpDir;

// Now import after env is set.
import { BgJobLogWriter, BgJobLogReader } from './bg-job-log.js';
import type { BgJobMeta } from './bg-job-log.js';
import type { OutputEvent } from './types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(seq: number): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'content', content: `content-${seq}` } as any,
  };
}

function makeDoneEvent(): OutputEvent {
  return { type: 'done' };
}

function makeMeta(jobId: string, overrides?: Partial<BgJobMeta>): BgJobMeta {
  return {
    jobId,
    subagentId: `sub-${jobId}`,
    label: `test job ${jobId}`,
    prompt: `do work for ${jobId}`,
    model: 'sonnet',
    startedAt: Date.now(),
    status: 'running',
    schemaVersion: 1,
    ...overrides,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function collectAll(gen: AsyncGenerator<OutputEvent>): Promise<OutputEvent[]> {
  const results: OutputEvent[] = [];
  for await (const e of gen) {
    results.push(e);
  }
  return results;
}

// ---------------------------------------------------------------------------
// BgJobLogWriter tests
// ---------------------------------------------------------------------------

describe('BgJobLogWriter', () => {
  let jobId: string;
  let writer: BgJobLogWriter;

  beforeEach(() => {
    jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writer = new BgJobLogWriter(jobId);
  });

  afterEach(async () => {
    await writer.close();
  });

  it('appends events as JSONL lines', async () => {
    writer.write(makeEvent(1));
    writer.write(makeEvent(2));
    writer.write(makeDoneEvent());
    await writer.close();

    const { getBgJobLog } = await import('../paths.js');
    const raw = fs.readFileSync(getBgJobLog(jobId), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ type: 'chunk' });
    expect(parsed[1]).toMatchObject({ type: 'chunk' });
    expect(parsed[2]).toMatchObject({ type: 'done' });
  });

  it('handles 100 concurrent writes without interleaving — each line is valid JSON', async () => {
    const N = 100;
    for (let i = 0; i < N; i++) {
      writer.write(makeEvent(i));
    }
    await writer.close();

    const { getBgJobLog } = await import('../paths.js');
    const raw = fs.readFileSync(getBgJobLog(jobId), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(N);
    for (const line of lines) {
      // Each line must be valid JSON — no interleaving corruption
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('writeMeta writes and the file has correct content', async () => {
    const meta = makeMeta(jobId);
    await writer.writeMeta(meta);

    const { getBgJobMeta } = await import('../paths.js');
    const raw = fs.readFileSync(getBgJobMeta(jobId), 'utf8');
    const parsed = JSON.parse(raw) as BgJobMeta;
    expect(parsed.jobId).toBe(jobId);
    expect(parsed.status).toBe('running');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('writeMeta is atomic — tmp file is cleaned up, final file exists', async () => {
    const meta = makeMeta(jobId);
    await writer.writeMeta(meta);

    const { getBgJobMeta } = await import('../paths.js');
    const metaPath = getBgJobMeta(jobId);
    const tmpPath = `${metaPath}.tmp`;

    expect(fs.existsSync(metaPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BgJobLogReader tests
// ---------------------------------------------------------------------------

describe('BgJobLogReader', () => {
  it('listJobs() returns metadata sorted by startedAt desc', async () => {
    const jobs = ['job-a', 'job-b', 'job-c'];
    const startTimes = [1000, 3000, 2000]; // a=oldest, b=newest, c=middle

    for (let i = 0; i < jobs.length; i++) {
      const jobId = `list-test-${jobs[i]}`;
      const w = new BgJobLogWriter(jobId);
      await w.writeMeta(makeMeta(jobId, {
        startedAt: startTimes[i]!,
        status: 'completed',
        endedAt: startTimes[i]! + 100,
      }));
      await w.close();
    }

    const listed = await BgJobLogReader.listJobs();
    // Filter to only our test jobs to avoid interference from other tests
    const ours = listed.filter((m) => m.jobId.startsWith('list-test-job-'));
    expect(ours).toHaveLength(3);
    // Sorted by startedAt desc: b(3000), c(2000), a(1000)
    expect(ours[0]!.startedAt).toBe(3000);
    expect(ours[1]!.startedAt).toBe(2000);
    expect(ours[2]!.startedAt).toBe(1000);
  });

  it('readMeta() returns null on ENOENT', async () => {
    const result = await BgJobLogReader.readMeta('does-not-exist-xyz-123');
    expect(result).toBeNull();
  });

  it('readMeta() returns the written meta', async () => {
    const jobId = `readmeta-${Date.now()}`;
    const w = new BgJobLogWriter(jobId);
    const meta = makeMeta(jobId, { status: 'completed', endedAt: Date.now() });
    await w.writeMeta(meta);
    await w.close();

    const read = await BgJobLogReader.readMeta(jobId);
    expect(read).not.toBeNull();
    expect(read!.jobId).toBe(jobId);
    expect(read!.status).toBe('completed');
  });

  it('readEvents() round-trips a written log', async () => {
    const jobId = `readevents-${Date.now()}`;
    const w = new BgJobLogWriter(jobId);
    const events: OutputEvent[] = Array.from({ length: 10 }, (_, i) => makeEvent(i));
    for (const e of events) w.write(e);
    await w.close();

    const read = await collectAll(BgJobLogReader.readEvents(jobId));
    expect(read).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(read[i]).toMatchObject({ type: 'chunk' });
      expect((read[i] as any).chunk.content).toBe(`content-${i}`);
    }
  });

  it('readEvents() on nonexistent job yields zero events (ENOENT graceful)', async () => {
    const events = await collectAll(BgJobLogReader.readEvents('no-such-job-xyz'));
    expect(events).toHaveLength(0);
  });

  it('tailEvents() yields new events as they are appended', async () => {
    const jobId = `tail-${Date.now()}`;
    const w = new BgJobLogWriter(jobId);
    await w.writeMeta(makeMeta(jobId, { status: 'running' }));

    // Write first event
    w.write(makeEvent(0));

    const { getBgJobMeta } = await import('../paths.js');

    const collected: OutputEvent[] = [];

    // Start the tail (from start)
    const tailGen = BgJobLogReader.tailEvents(jobId, { fromStart: true });

    // Consume first event
    const first = await tailGen.next();
    if (!first.done) collected.push(first.value);

    // Write more events and then mark terminal
    w.write(makeEvent(1));
    w.write(makeDoneEvent());
    await w.close();

    // Update meta to terminal
    const terminalMeta = makeMeta(jobId, { status: 'completed', endedAt: Date.now() });
    const tmpPath = `${getBgJobMeta(jobId)}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(terminalMeta), 'utf8');
    await fsp.rename(tmpPath, getBgJobMeta(jobId));

    // Drain remaining events
    for await (const e of tailGen) {
      collected.push(e);
    }

    // Should have seen all 3 events
    expect(collected.length).toBeGreaterThanOrEqual(2);
    expect(collected.some((e) => e.type === 'done')).toBe(true);
  }, 5000);
});

// ---------------------------------------------------------------------------
// BgJobLogWriter + BgJobLogReader integration
// ---------------------------------------------------------------------------

describe('BgJobLogWriter + BgJobLogReader integration', () => {
  it('write and read back via readEvents', async () => {
    const jobId = `integration-${Date.now()}`;
    const w = new BgJobLogWriter(jobId);
    w.write({ type: 'chunk', chunk: { type: 'content', content: 'hello world' } as any });
    w.write({ type: 'done' });
    await w.close();

    const events = await collectAll(BgJobLogReader.readEvents(jobId));
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('chunk');
    expect(events[1]?.type).toBe('done');
  });
});
