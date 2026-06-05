/**
 * Tests for `afk bg` CLI command group.
 *
 * Exercises `list`, `tail`, and `replay` subcommands using a temp
 * AFK_HOME so no real ~/.afk/state/bg/ is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// Set up isolated temp dir for AFK_HOME before any imports that use paths.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-bg-cmd-test-'));
process.env['AFK_HOME'] = tmpDir;

import { BgJobLogWriter } from '../../agent/bg-job-log.js';
import { BgJobLogReader } from '../../agent/bg-job-log.js';
import type { BgJobMeta } from '../../agent/bg-job-log.js';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedJob(
  jobId: string,
  meta: Partial<BgJobMeta>,
  events: OutputEvent[],
): Promise<void> {
  const w = new BgJobLogWriter(jobId);
  await w.writeMeta({
    jobId,
    subagentId: `sub-${jobId}`,
    label: `test job ${jobId}`,
    prompt: `prompt for ${jobId}`,
    model: 'sonnet',
    startedAt: Date.now() - 1000,
    status: 'completed',
    endedAt: Date.now(),
    schemaVersion: 1,
    ...meta,
  });
  for (const e of events) {
    w.write(e);
  }
  await w.close();
}

// ---------------------------------------------------------------------------
// Tests — test the reader layer that the CLI commands use, rather than
// going through Commander (which adds process-exit complexity). The CLI
// command's logic is a thin wrapper around BgJobLogReader; we test both
// the reader contract and the integration here.
// ---------------------------------------------------------------------------

describe('afk bg list — BgJobLogReader.listJobs()', () => {
  it('returns metadata for seeded jobs, sorted by startedAt desc', async () => {
    const jobA = `list-a-${Date.now()}`;
    const jobB = `list-b-${Date.now() + 1}`;
    await seedJob(jobA, { startedAt: 1000, status: 'completed' }, []);
    await seedJob(jobB, { startedAt: 2000, status: 'failed' }, []);

    const jobs = await BgJobLogReader.listJobs();
    const ours = jobs.filter((j) => j.jobId === jobA || j.jobId === jobB);
    expect(ours).toHaveLength(2);
    expect(ours[0]!.startedAt).toBeGreaterThanOrEqual(ours[1]!.startedAt);
  });

  it('returns empty array when no bg dir exists', async () => {
    const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-bg-empty-'));
    const origHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = freshTmp;
    try {
      const jobs = await BgJobLogReader.listJobs();
      expect(jobs).toEqual([]);
    } finally {
      process.env['AFK_HOME'] = origHome;
    }
  });
});

describe('afk bg replay <jobId> — BgJobLogReader.readEvents()', () => {
  it('yields JSONL events in order', async () => {
    const jobId = `replay-${Date.now()}`;
    await seedJob(jobId, {}, [
      { type: 'chunk', chunk: { type: 'content', content: 'hello replay' } as any },
      { type: 'done' },
    ]);

    const events: OutputEvent[] = [];
    for await (const e of BgJobLogReader.readEvents(jobId)) {
      events.push(e);
    }

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('chunk');
    expect(events[1]?.type).toBe('done');
  });

  it('yields zero events for nonexistent job', async () => {
    const events: OutputEvent[] = [];
    for await (const e of BgJobLogReader.readEvents('no-such-job-xyz')) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
  });
});

describe('afk bg tail <jobId> --no-follow — BgJobLogReader.readEvents()', () => {
  it('reads existing events and exits without hanging', async () => {
    const jobId = `tail-nf-${Date.now()}`;
    await seedJob(jobId, {}, [
      { type: 'chunk', chunk: { type: 'content', content: 'tail event' } as any },
    ]);

    const events: OutputEvent[] = [];
    for await (const e of BgJobLogReader.readEvents(jobId)) {
      events.push(e);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('chunk');
  });
});
