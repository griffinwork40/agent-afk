/**
 * Tests for peer send guards: rate limit, duplicate window, hop limit,
 * size cap, and wake budget (with injected clock).
 *
 * Isolates AFK_STATE_DIR to a temp directory so no real inbox state is used.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

let tmpDir: string;
let origStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-guards-test-'));
  origStateDir = process.env['AFK_STATE_DIR'];
  process.env['AFK_STATE_DIR'] = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origStateDir === undefined) {
    delete process.env['AFK_STATE_DIR'];
  } else {
    process.env['AFK_STATE_DIR'] = origStateDir;
  }
});

async function getGuards() {
  return import('./guards.js');
}

async function getInboxStore() {
  return import('./inbox-store.js');
}

const SENDER = 'sender-aaa111';
const TARGET = 'target-bbb222';

function baseOpts(overrides?: Record<string, unknown>) {
  return {
    senderId: SENDER,
    targetId: TARGET,
    body: 'hello',
    hop: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

describe('checkSendGuards — size cap', () => {
  it('allows a message within 64KB', async () => {
    const { checkSendGuards } = await getGuards();
    const result = await checkSendGuards(baseOpts({ body: 'a'.repeat(100) }));
    expect(result).toBeNull();
  });

  it('rejects a message over 64KB', async () => {
    const { checkSendGuards } = await getGuards();
    const bigBody = 'x'.repeat(64 * 1024 + 1);
    const result = await checkSendGuards(baseOpts({ body: bigBody }));
    expect(result).toBe('too-large');
  });

  it('allows exactly 64KB', async () => {
    const { checkSendGuards } = await getGuards();
    const exactBody = 'x'.repeat(64 * 1024);
    const result = await checkSendGuards(baseOpts({ body: exactBody }));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hop limit
// ---------------------------------------------------------------------------

describe('checkSendGuards — hop limit', () => {
  it('allows hop = 6 (at limit)', async () => {
    const { checkSendGuards } = await getGuards();
    const result = await checkSendGuards(baseOpts({ hop: 6 }));
    expect(result).toBeNull();
  });

  it('rejects hop > 6', async () => {
    const { checkSendGuards } = await getGuards();
    const result = await checkSendGuards(baseOpts({ hop: 7 }));
    expect(result).toBe('hop-limit');
  });
});

// ---------------------------------------------------------------------------
// Rate limit — 10 msgs / min per sender→target pair
// ---------------------------------------------------------------------------

describe('checkSendGuards — rate limit', () => {
  it('allows up to 10 messages per minute', async () => {
    const { checkSendGuards } = await getGuards();
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();

    // Write 9 distinct messages into delivered/ (simulating prior sends).
    const nowMs = Date.now();
    for (let i = 0; i < 9; i++) {
      const ts = new Date(nowMs - (9 - i) * 1000).toISOString();
      const env = {
        v: 1 as const,
        messageId: `rate-msg-${i}`,
        from: { id: SENDER },
        to: TARGET,
        hop: 0,
        ts,
        body: `unique message ${i}`,
      };
      await writeEnvelope(env);
      const files = await listPending(TARGET);
      const file = files.find((f) => f.includes(`rate-msg-${i}`))!;
      await claimPending(TARGET, file);
    }

    // 10th message in the minute should still pass.
    const result = await checkSendGuards(baseOpts({ body: 'new unique body', now: () => nowMs }));
    expect(result).toBeNull();
  });

  it('rejects the 11th message within a minute', async () => {
    const { checkSendGuards } = await getGuards();
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();

    const nowMs = Date.now();
    // Write 10 messages with unique bodies to avoid duplicate detection.
    for (let i = 0; i < 10; i++) {
      const ts = new Date(nowMs - (10 - i) * 1000).toISOString();
      const env = {
        v: 1 as const,
        messageId: `rate-msg-${i}`,
        from: { id: SENDER },
        to: TARGET,
        hop: 0,
        ts,
        body: `unique msg ${i} for rate test`,
      };
      await writeEnvelope(env);
      const files = await listPending(TARGET);
      const file = files.find((f) => f.includes(`rate-msg-${i}`))!;
      await claimPending(TARGET, file);
    }

    // 11th attempt in the same minute should be rate-limited.
    const result = await checkSendGuards(baseOpts({ body: 'eleven', now: () => nowMs }));
    expect(result).toBe('rate-limited');
  });
});

// ---------------------------------------------------------------------------
// Duplicate window — same body within 60s
// ---------------------------------------------------------------------------

describe('checkSendGuards — duplicate window', () => {
  it('rejects duplicate body within 60s', async () => {
    const { checkSendGuards } = await getGuards();
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();

    const nowMs = Date.now();
    const dupBody = 'duplicate message body';
    const ts = new Date(nowMs - 30_000).toISOString(); // 30s ago
    const env = {
      v: 1 as const,
      messageId: 'dup-msg-1',
      from: { id: SENDER },
      to: TARGET,
      hop: 0,
      ts,
      body: dupBody,
    };
    await writeEnvelope(env);
    const files = await listPending(TARGET);
    await claimPending(TARGET, files[0]!);

    // Same body within 60s → duplicate.
    const result = await checkSendGuards(baseOpts({ body: dupBody, now: () => nowMs }));
    expect(result).toBe('duplicate');
  });

  it('allows duplicate body older than 60s', async () => {
    const { checkSendGuards } = await getGuards();
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();

    const nowMs = Date.now();
    const dupBody = 'old duplicate body';
    const ts = new Date(nowMs - 70_000).toISOString(); // 70s ago — outside window
    const env = {
      v: 1 as const,
      messageId: 'old-dup-msg',
      from: { id: SENDER },
      to: TARGET,
      hop: 0,
      ts,
      body: dupBody,
    };
    await writeEnvelope(env);
    const files = await listPending(TARGET);
    await claimPending(TARGET, files[0]!);

    // Same body but outside the duplicate window → allowed.
    const result = await checkSendGuards(baseOpts({ body: dupBody, now: () => nowMs }));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wake budget (injected clock)
// ---------------------------------------------------------------------------

describe('createWakeBudget', () => {
  it('allows up to 20 wakes per sender per hour', async () => {
    const { createWakeBudget } = await getGuards();
    let fakeNow = 0;
    const budget = createWakeBudget({ now: () => fakeNow });

    for (let i = 0; i < 20; i++) {
      fakeNow += 1000; // advance 1s each time
      expect(budget.tryConsume('sender-a')).toBe(true);
    }
  });

  it('rejects the 21st wake in an hour', async () => {
    const { createWakeBudget } = await getGuards();
    let fakeNow = 0;
    const budget = createWakeBudget({ now: () => fakeNow });

    for (let i = 0; i < 20; i++) {
      fakeNow += 100;
      budget.tryConsume('sender-a');
    }
    // 21st attempt in the same hour is rejected.
    fakeNow += 100;
    expect(budget.tryConsume('sender-a')).toBe(false);
  });

  it('budget refills after an hour (injected clock)', async () => {
    const { createWakeBudget } = await getGuards();
    let fakeNow = 0;
    const budget = createWakeBudget({ now: () => fakeNow });

    // Exhaust budget.
    for (let i = 0; i < 20; i++) {
      fakeNow += 100;
      budget.tryConsume('sender-a');
    }
    expect(budget.tryConsume('sender-a')).toBe(false);

    // Advance past one hour — all previous entries expire.
    fakeNow += 3_600_000 + 1;
    expect(budget.tryConsume('sender-a')).toBe(true);
  });

  it('budget tracks per-sender independently', async () => {
    const { createWakeBudget } = await getGuards();
    let fakeNow = 0;
    const budget = createWakeBudget({ now: () => fakeNow });

    // Exhaust sender-a.
    for (let i = 0; i < 20; i++) {
      fakeNow += 100;
      budget.tryConsume('sender-a');
    }
    fakeNow += 100;
    expect(budget.tryConsume('sender-a')).toBe(false);

    // sender-b is unaffected.
    expect(budget.tryConsume('sender-b')).toBe(true);
  });

  it('respects perSenderPerHour option', async () => {
    const { createWakeBudget } = await getGuards();
    let fakeNow = 0;
    const budget = createWakeBudget({ perSenderPerHour: 3, now: () => fakeNow });

    for (let i = 0; i < 3; i++) {
      fakeNow += 100;
      expect(budget.tryConsume('sender-x')).toBe(true);
    }
    fakeNow += 100;
    expect(budget.tryConsume('sender-x')).toBe(false);
  });
});
