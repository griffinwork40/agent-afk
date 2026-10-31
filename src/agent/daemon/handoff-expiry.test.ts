import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HANDOFF_TTL_MS,
  EXPIRY_SWEEP_INTERVAL_MS,
  RESUME_QUEUE_SUBDIR,
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
import { listPending } from './queue-store.js';
import { getHandoffsDir } from '../../paths.js';
import { operatorNotify } from '../operator-notify.js';

vi.mock('../operator-notify.js', () => ({
  operatorNotify: vi.fn().mockResolvedValue(undefined),
}));

const HOUR = 60 * 60 * 1_000;
const NOW = Date.parse('2026-10-15T12:00:00.000Z');

let handoffsDir: string;
let queueDir: string;

beforeEach(async () => {
  handoffsDir = await mkdtemp(join(tmpdir(), 'afk-handoff-expiry-'));
  queueDir = await mkdtemp(join(tmpdir(), 'afk-handoff-expiry-queue-'));
  vi.mocked(operatorNotify).mockClear();
  resetExpirySweepThrottleForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(operatorNotify).toHaveBeenCalledTimes(1);
    const notice = vi.mocked(operatorNotify).mock.calls[0]?.[0] as string;
    expect(notice).toContain('q-stale');
    expect(notice).toContain('expired');

    // Second call is a no-op: no second transition, no second notice.
    expect(await expireHandoff('q-stale', { handoffsDir, queueDir, now: NOW })).toBe(false);
    expect(operatorNotify).toHaveBeenCalledTimes(1);
  });

  it('routes the notice to the chat/thread the question was sent to', async () => {
    vi.stubEnv('AFK_TELEGRAM_ALLOWED_CHAT_IDS', '42,-100123');
    await writeHandoff(record('q-routed', 25 * HOUR, { route: { chatId: -100123, threadId: 7 } }), handoffsDir);
    expect(await expireHandoff('q-routed', { handoffsDir, queueDir, now: NOW })).toBe(true);
    expect(vi.mocked(operatorNotify).mock.calls[0]?.[1]).toEqual({ target: -100123, messageThreadId: 7 });
  });

  it('falls back to default routing when the routed chat is no longer allowlisted', async () => {
    vi.stubEnv('AFK_TELEGRAM_ALLOWED_CHAT_IDS', '42');
    await writeHandoff(record('q-revoked', 25 * HOUR, { route: { chatId: -100123, threadId: 7 } }), handoffsDir);
    expect(await expireHandoff('q-revoked', { handoffsDir, queueDir, now: NOW })).toBe(true);
    expect(operatorNotify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(operatorNotify).mock.calls[0]?.[1]).toBeUndefined();
  });

  it('still notifies (default routing) and counts when route is null or malformed', async () => {
    vi.stubEnv('AFK_TELEGRAM_ALLOWED_CHAT_IDS', '42');
    await writeHandoff(record('q-nullroute', 25 * HOUR, { route: null as unknown as HandoffRecord['route'] }), handoffsDir);
    await writeHandoff(record('q-badroute', 25 * HOUR, { route: { chatId: 'x' } as unknown as HandoffRecord['route'] }), handoffsDir);
    expect(await expireStaleHandoffs({ handoffsDir, queueDir, now: NOW })).toBe(2);
    expect(operatorNotify).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(operatorNotify).mock.calls) expect(call[1]).toBeUndefined();
    expect((await readHandoff('q-nullroute', handoffsDir))?.status).toBe('expired');
  });

  it('uses default routing when the record has no route', async () => {
    await writeHandoff(record('q-unrouted', 25 * HOUR), handoffsDir);
    expect(await expireHandoff('q-unrouted', { handoffsDir, queueDir, now: NOW })).toBe(true);
    expect(vi.mocked(operatorNotify).mock.calls[0]?.[1]).toBeUndefined();
  });

  it('still expires and notifies when question is null', async () => {
    await writeHandoff(record('q-nullq', 25 * HOUR, { question: null as unknown as Record<string, unknown> }), handoffsDir);
    expect(await expireHandoff('q-nullq', { handoffsDir, queueDir, now: NOW })).toBe(true);
    expect(String(vi.mocked(operatorNotify).mock.calls[0]?.[0])).toContain('question details unavailable');
  });

  it('reclaims (dead-letters) a lease parked in the resume queue when attempts exhausted', async () => {
    const resumeDir = join(queueDir, RESUME_QUEUE_SUBDIR);
    const dir = join(resumeDir, 'leased');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q-resumed.json'), JSON.stringify({
      id: 'q-resumed', command: '/x', state: 'waiting_human_input', attempts: 1, maxAttempts: 1,
      leaseExpiry: NOW - 1, createdAt: NOW, updatedAt: NOW,
    }));
    await writeHandoff(record('q-resumed', 25 * HOUR), handoffsDir);
    expect(await expireHandoff('q-resumed', { handoffsDir, queueDir, now: NOW })).toBe(true);
    // reclaimSingleLease ran: exhausted attempts → dead-letter, not stranded in leased/
    expect(getTaskRecord('q-resumed', resumeDir)?.state).toBe('dead-letter');
  });

  it('re-enqueues a resume-queue lease when attempts remain', async () => {
    const resumeDir = join(queueDir, RESUME_QUEUE_SUBDIR);
    const leasedDir = join(resumeDir, 'leased');
    mkdirSync(leasedDir, { recursive: true });
    writeFileSync(join(leasedDir, 'q-retry.json'), JSON.stringify({
      id: 'q-retry', command: '/x', state: 'waiting_human_input', attempts: 1, maxAttempts: 3,
      leaseExpiry: NOW - 1, createdAt: NOW, updatedAt: NOW,
    }));
    await writeHandoff(record('q-retry', 25 * HOUR), handoffsDir);
    expect(await expireHandoff('q-retry', { handoffsDir, queueDir, now: NOW })).toBe(true);
    // reclaimSingleLease ran: attempts < maxAttempts → re-enqueued into resume queue
    expect(listPending(resumeDir).map((t) => t.id)).toContain('q-retry');
  });

  it('leaves a fresh record pending', async () => {
    await writeHandoff(record('q-fresh', 1 * HOUR), handoffsDir);
    expect(await expireHandoff('q-fresh', { handoffsDir, queueDir, now: NOW })).toBe(false);
    expect((await readHandoff('q-fresh', handoffsDir))?.status).toBe('pending');
    expect(operatorNotify).not.toHaveBeenCalled();
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
    expect(operatorNotify).not.toHaveBeenCalled();
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

  it('reclaims a parked lease immediately: dead-letters when attempts exhausted', async () => {
    await writeHandoff(record('q-parked', 25 * HOUR), handoffsDir);
    writeLease('q-parked', 'waiting_human_input');

    await expireHandoff('q-parked', { handoffsDir, queueDir, now: NOW });

    // reclaimSingleLease ran after setLeaseState restored the lease (#3880):
    // attempts:1 >= maxAttempts:1 → dead-lettered, not stranded in leased/
    expect(getTaskRecord('q-parked', queueDir)?.state).toBe('dead-letter');
  });

  it('re-enqueues a parked main-queue lease immediately when attempts remain', async () => {
    await writeHandoff(record('q-parked-retry', 25 * HOUR), handoffsDir);
    const dir = join(queueDir, 'leased');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'q-parked-retry.json'), JSON.stringify({
      id: 'q-parked-retry',
      command: '/original',
      state: 'waiting_human_input',
      attempts: 1,
      maxAttempts: 3,
      leaseExpiry: NOW - 1,
      createdAt: NOW - 25 * HOUR,
      updatedAt: NOW - 25 * HOUR,
    }));

    await expireHandoff('q-parked-retry', { handoffsDir, queueDir, now: NOW });

    // reclaimSingleLease ran: attempts < maxAttempts → re-enqueued
    expect(listPending(queueDir).map((t) => t.id)).toContain('q-parked-retry');
  });

  it('does not reclaim an unrelated long-running task whose lease has expired (no renewLease caller)', async () => {
    // Simulate: two tasks in the queue dir.
    //   - q-expired-handoff: parked in waiting_human_input; its handoff is stale → expireHandoff fires
    //   - q-long-running: a genuine in-flight task running >10 min, leaseExpiry < now (no renewal)
    // After expireHandoff for q-expired-handoff, q-long-running must remain in leased/ untouched.
    await writeHandoff(record('q-expired-handoff', 25 * HOUR), handoffsDir);
    writeLease('q-expired-handoff', 'waiting_human_input');

    const leasedDir = join(queueDir, 'leased');
    mkdirSync(leasedDir, { recursive: true });
    writeFileSync(join(leasedDir, 'q-long-running.json'), JSON.stringify({
      id: 'q-long-running',
      command: '/long-task',
      state: 'leased',
      attempts: 1,
      maxAttempts: 1,
      leaseExpiry: NOW - 1, // expired — no renewLease in production
      createdAt: NOW - 25 * HOUR,
      updatedAt: NOW - 25 * HOUR,
    }));

    await expireHandoff('q-expired-handoff', { handoffsDir, queueDir, now: NOW });

    // The unrelated long-running task must be untouched — only q-expired-handoff was reclaimed.
    expect(getTaskRecord('q-long-running', queueDir)?.state).toBe('leased');
  });

  it('does not reclaim the restored lease when the task is still in-flight', async () => {
    // Even after setLeaseState restores the lease to 'leased', if isInFlight returns
    // true for that task id, reclaimSingleLease must leave it alone.
    await writeHandoff(record('q-inflight', 25 * HOUR), handoffsDir);
    writeLease('q-inflight', 'waiting_human_input');

    const isInFlight = (id: string) => id === 'q-inflight';

    await expireHandoff('q-inflight', { handoffsDir, queueDir, now: NOW, isInFlight });

    // Lease was restored to 'leased' but NOT reclaimed — task is in-flight.
    expect(getTaskRecord('q-inflight', queueDir)?.state).toBe('leased');
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
