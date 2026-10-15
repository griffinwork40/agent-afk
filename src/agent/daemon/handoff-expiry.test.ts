import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HANDOFF_TTL_MS,
  EXPIRY_SWEEP_INTERVAL_MS,
  expireHandoff,
  expireStaleHandoffs,
  isHandoffStale,
  resetExpirySweepThrottleForTests,
  sweepExpiredHandoffs,
} from './handoff-expiry.js';
import {
  readHandoff,
  updateHandoffAnswer,
  writeHandoff,
  type HandoffRecord,
} from './handoff-store.js';
import { getTaskRecord } from './lease-store.js';
import { getHandoffsDir } from '../../paths.js';
import { pushIfConfigured } from '../../telegram/push.js';

vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(undefined),
}));

const HOUR = 60 * 60 * 1_000;
const NOW = Date.parse('2026-10-15T12:00:00.000Z');

let handoffsDir: string;
let queueDir: string;

beforeEach(async () => {
  handoffsDir = await mkdtemp(join(tmpdir(), 'afk-handoff-expiry-'));
  queueDir = await mkdtemp(join(tmpdir(), 'afk-handoff-expiry-queue-'));
  vi.mocked(pushIfConfigured).mockClear();
  resetExpirySweepThrottleForTests();
});

function record(taskId: string, ageMs: number, overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    taskId,
    sessionId: 'sess-1',
    question: { message: `Question for ${taskId}?` },
    requestType: 'ask_question',
    createdAt: new Date(NOW - ageMs).toISOString(),
    status: 'pending',
    originalCommand: '/original',
    ...overrides,
  };
}

function writeLease(taskId: string, state: string): void {
  const dir = join(queueDir, 'leased');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.json`), JSON.stringify({
    id: taskId,
    command: '/original',
    state,
    attempts: 1,
    maxAttempts: 1,
    leaseExpiry: NOW - 1,
    createdAt: NOW - 25 * HOUR,
    updatedAt: NOW - 25 * HOUR,
  }));
}

describe('isHandoffStale', () => {
  it('is true only past the TTL', () => {
    expect(isHandoffStale(record('q-a', 25 * HOUR), NOW)).toBe(true);
    expect(isHandoffStale(record('q-b', 23 * HOUR), NOW)).toBe(false);
    expect(isHandoffStale(record('q-c', DEFAULT_HANDOFF_TTL_MS), NOW)).toBe(false);
  });

  it('never treats an unparseable createdAt as stale', () => {
    expect(isHandoffStale({ createdAt: 'not-a-date' }, NOW)).toBe(false);
  });
});

describe('expireHandoff', () => {
  it('expires a stale pending record, stamps expiredAt, and notifies once', async () => {
    await writeHandoff(record('q-stale', 25 * HOUR), handoffsDir);

    expect(await expireHandoff('q-stale', { handoffsDir, queueDir, now: NOW })).toBe(true);

    const after = await readHandoff('q-stale', handoffsDir);
    expect(after?.status).toBe('expired');
    expect(after?.expiredAt).toBe(new Date(NOW).toISOString());
    expect(pushIfConfigured).toHaveBeenCalledTimes(1);
    const notice = vi.mocked(pushIfConfigured).mock.calls[0]?.[0] as string;
    expect(notice).toContain('q-stale');
    expect(notice).toContain('expired');

    // Second call is a no-op: no second transition, no second notice.
    expect(await expireHandoff('q-stale', { handoffsDir, queueDir, now: NOW })).toBe(false);
    expect(pushIfConfigured).toHaveBeenCalledTimes(1);
  });

  it('leaves a fresh record pending', async () => {
    await writeHandoff(record('q-fresh', 1 * HOUR), handoffsDir);
    expect(await expireHandoff('q-fresh', { handoffsDir, queueDir, now: NOW })).toBe(false);
    expect((await readHandoff('q-fresh', handoffsDir))?.status).toBe('pending');
    expect(pushIfConfigured).not.toHaveBeenCalled();
  });

  it('never overwrites an answer that landed after the record was listed', async () => {
    // A sweep lists the record while pending, then the operator answers before
    // the sweep reaches it. The expiry must re-read under the lock and back off.
    await writeHandoff(record('q-raced', 25 * HOUR), handoffsDir);
    const won = await updateHandoffAnswer('q-raced', 'yes', 'telegram', { handoffsDir });
    expect(won.won).toBe(true);

    expect(await expireHandoff('q-raced', { handoffsDir, queueDir, now: NOW })).toBe(false);

    const after = await readHandoff('q-raced', handoffsDir);
    expect(after?.status).toBe('answered');
    expect(after?.answer).toBe('yes');
    expect(pushIfConfigured).not.toHaveBeenCalled();
  });

  it('backs off while a concurrent answer holds the handoff lock', async () => {
    await writeHandoff(record('q-locked', 25 * HOUR), handoffsDir);
    await writeFile(join(handoffsDir, 'q-locked.lock'), '');

    expect(await expireHandoff('q-locked', { handoffsDir, queueDir, now: NOW })).toBe(false);
    expect((await readHandoff('q-locked', handoffsDir))?.status).toBe('pending');
  });

  it('serialises a concurrent answer and expiry: exactly one wins', async () => {
    await writeHandoff(record('q-concurrent', 25 * HOUR), handoffsDir);

    const [expired, answered] = await Promise.all([
      expireHandoff('q-concurrent', { handoffsDir, queueDir, now: NOW }),
      updateHandoffAnswer('q-concurrent', 'go', 'web', { handoffsDir }),
    ]);

    const after = await readHandoff('q-concurrent', handoffsDir);
    if (after?.status === 'answered') {
      expect(after.answer).toBe('go');
      expect(expired).toBe(false);
    } else {
      expect(after?.status).toBe('expired');
      expect(after?.answer).toBeUndefined();
      expect(answered.won).toBe(false);
    }
    expect(expired && answered.won).toBe(false);
  });

  it('restores a lease parked in waiting_human_input to leased', async () => {
    await writeHandoff(record('q-parked', 25 * HOUR), handoffsDir);
    writeLease('q-parked', 'waiting_human_input');

    await expireHandoff('q-parked', { handoffsDir, queueDir, now: NOW });

    expect(getTaskRecord('q-parked', queueDir)?.state).toBe('leased');
  });

  it('does not touch a lease another path has already moved on', async () => {
    await writeHandoff(record('q-moved', 25 * HOUR), handoffsDir);
    writeLease('q-moved', 'retrying');

    expect(await expireHandoff('q-moved', { handoffsDir, queueDir, now: NOW })).toBe(true);

    expect(getTaskRecord('q-moved', queueDir)?.state).toBe('retrying');
  });
});

describe('expireStaleHandoffs', () => {
  it('expires only stale pending records and counts them', async () => {
    await writeHandoff(record('q-old-1', 30 * HOUR), handoffsDir);
    await writeHandoff(record('q-old-2', 48 * HOUR), handoffsDir);
    await writeHandoff(record('q-new', 2 * HOUR), handoffsDir);
    await writeHandoff(record('q-done', 30 * HOUR, { status: 'answered', answer: 1 }), handoffsDir);

    expect(await expireStaleHandoffs({ handoffsDir, queueDir, now: NOW })).toBe(2);
    expect((await readHandoff('q-new', handoffsDir))?.status).toBe('pending');
    expect((await readHandoff('q-done', handoffsDir))?.status).toBe('answered');
    expect(await expireStaleHandoffs({ handoffsDir, queueDir, now: NOW })).toBe(0);
  });

  it('honours a custom TTL', async () => {
    await writeHandoff(record('q-short', 2 * HOUR), handoffsDir);
    expect(await expireStaleHandoffs({ handoffsDir, queueDir, now: NOW, ttlMs: HOUR })).toBe(1);
  });
});

describe('sweepExpiredHandoffs', () => {
  it('runs at most once per interval against the default handoffs dir', async () => {
    const dir = getHandoffsDir();
    // Records are aged relative to the real clock: the sweep passes `now`
    // through, and the lock/staleness check uses that same value.
    const now = Date.now();
    await writeHandoff({ ...record('q-sweep-1', 0), createdAt: new Date(now - 25 * HOUR).toISOString() }, dir);

    sweepExpiredHandoffs(queueDir, now);
    await vi.waitFor(async () => {
      expect((await readHandoff('q-sweep-1', dir))?.status).toBe('expired');
    });

    await writeHandoff({ ...record('q-sweep-2', 0), createdAt: new Date(now - 25 * HOUR).toISOString() }, dir);
    sweepExpiredHandoffs(queueDir, now + 1_000); // inside the interval: skipped
    await new Promise((r) => setTimeout(r, 50));
    expect((await readHandoff('q-sweep-2', dir))?.status).toBe('pending');

    sweepExpiredHandoffs(queueDir, now + EXPIRY_SWEEP_INTERVAL_MS + 1);
    await vi.waitFor(async () => {
      expect((await readHandoff('q-sweep-2', dir))?.status).toBe('expired');
    });
  });
});
