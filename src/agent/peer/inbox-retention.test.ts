/**
 * Tests for `pruneDeliveredReceipts` (per-file delivered/ retention).
 *
 * Filesystem isolation: each test uses a fresh AFK_STATE_DIR so no real
 * state is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Env isolation — must happen before any module that reads paths.ts
// ---------------------------------------------------------------------------

let tmpDir: string;
let origStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-retention-test-'));
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-retention';

function deliveredDir(): string {
  return path.join(tmpDir, 'inbox', SESSION_ID, 'delivered');
}

function pendingDir(): string {
  return path.join(tmpDir, 'inbox', SESSION_ID, 'pending');
}

/** Write a delivered receipt with a given mtime and return the filename. */
function writeDeliveredReceipt(
  messageId: string,
  ts: string,
  mtimeMs: number,
): string {
  fs.mkdirSync(deliveredDir(), { recursive: true });
  const filename = `${ts.replace(/[:.]/g, '-')}-${messageId}.json`;
  const envelope = JSON.stringify({
    v: 1,
    messageId,
    from: { id: 'sender-aaa' },
    to: SESSION_ID,
    hop: 0,
    ts,
    body: 'hello',
  });
  const filepath = path.join(deliveredDir(), filename);
  fs.writeFileSync(filepath, envelope, { mode: 0o600 });
  const mtimeDate = new Date(mtimeMs);
  fs.utimesSync(filepath, mtimeDate, mtimeDate);
  return filename;
}

/** Write a pending source (same filename as the receipt it mirrors). */
function writePendingSource(filename: string): void {
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(path.join(pendingDir(), filename), '{}', { mode: 0o600 });
}

/**
 * Write an injection-ack marker to `delivered/acked/<filename>`, simulating
 * a message that was successfully injected into a model turn. Receipts without
 * an ack marker are retained by `pruneDeliveredReceipts` as potential crash
 * residue (per Finding 3 / `UNACKED_RETENTION_MAX_AGE_MS`).
 */
function writeAckMarker(filename: string): void {
  const ackedDir = path.join(deliveredDir(), 'acked');
  fs.mkdirSync(ackedDir, { recursive: true });
  fs.writeFileSync(path.join(ackedDir, filename), SESSION_ID, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Import the module under test. Dynamically imported so env isolation applies.
// ---------------------------------------------------------------------------

async function getRetention() {
  return import('./inbox-retention.js');
}

// ---------------------------------------------------------------------------
// Throttle behaviour
// ---------------------------------------------------------------------------

describe('pruneDeliveredReceipts — throttle', () => {
  it('returns ran=false when the interval has not elapsed', async () => {
    const { pruneDeliveredReceipts } = await getRetention();
    const now = () => 1_000_000;
    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 999_000, // only 1 s ago
      minIntervalMs: 5_000,
      now,
    });
    expect(result.ran).toBe(false);
    expect(result.pruned).toBe(0);
  });

  it('returns ran=true when the interval has elapsed', async () => {
    const { pruneDeliveredReceipts } = await getRetention();
    const now = () => 1_000_000;
    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 0, // never run
      minIntervalMs: 5_000,
      now,
    });
    expect(result.ran).toBe(true);
  });

  it('returns nowMs = lastRanMs when throttled', async () => {
    const { pruneDeliveredReceipts } = await getRetention();
    const now = () => 1_000_000;
    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 999_000,
      minIntervalMs: 5_000,
      now,
    });
    expect(result.nowMs).toBe(999_000); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Old receipt pruned
// ---------------------------------------------------------------------------

describe('pruneDeliveredReceipts — old receipt pruned', () => {
  it('removes a stale delivered receipt (older than threshold)', async () => {
    const { pruneDeliveredReceipts, DELIVERED_RECEIPT_MAX_AGE_MS } = await getRetention();

    const nowMs = 10_000_000;
    const staleAge = DELIVERED_RECEIPT_MAX_AGE_MS + 1_000;
    const filename = writeDeliveredReceipt('msg-stale', '2026-10-01T00:00:00.001Z', nowMs - staleAge);
    // Write ack marker: this receipt was successfully injected, so it is safe
    // to prune once it exceeds the age threshold.
    writeAckMarker(filename);

    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 0,
      minIntervalMs: 0,
      now: () => nowMs,
    });

    expect(result.ran).toBe(true);
    expect(result.pruned).toBe(1);
    expect(result.skippedFresh).toBe(0);
    expect(result.skippedHasPending).toBe(0);
    expect(result.skippedUnacked).toBe(0);
    // Only the acked/ subdir remains (the receipt file was pruned).
    expect(fs.readdirSync(deliveredDir()).filter(f => f !== 'acked')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fresh receipt kept
// ---------------------------------------------------------------------------

describe('pruneDeliveredReceipts — fresh receipt kept', () => {
  it('does not remove a fresh receipt (within threshold)', async () => {
    const { pruneDeliveredReceipts, DELIVERED_RECEIPT_MAX_AGE_MS } = await getRetention();

    const nowMs = 10_000_000;
    // Receipt is half the max age — should not be pruned.
    const freshAge = DELIVERED_RECEIPT_MAX_AGE_MS / 2;
    writeDeliveredReceipt('msg-fresh', '2026-10-01T00:00:00.002Z', nowMs - freshAge);

    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 0,
      minIntervalMs: 0,
      now: () => nowMs,
    });

    expect(result.ran).toBe(true);
    expect(result.pruned).toBe(0);
    expect(result.skippedFresh).toBe(1);
    expect(fs.readdirSync(deliveredDir())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Old receipt with surviving pending source — must be kept (claim-authority invariant)
// ---------------------------------------------------------------------------

describe('pruneDeliveredReceipts — old receipt with surviving pending source kept', () => {
  it('skips a stale receipt whose pending source still exists', async () => {
    const { pruneDeliveredReceipts, DELIVERED_RECEIPT_MAX_AGE_MS } = await getRetention();

    const nowMs = 10_000_000;
    const staleAge = DELIVERED_RECEIPT_MAX_AGE_MS + 1_000;
    const filename = writeDeliveredReceipt('msg-orphan', '2026-10-01T00:00:00.003Z', nowMs - staleAge);
    // Write a matching pending source (same filename).
    writePendingSource(filename);

    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 0,
      minIntervalMs: 0,
      now: () => nowMs,
    });

    expect(result.ran).toBe(true);
    expect(result.pruned).toBe(0);
    expect(result.skippedHasPending).toBe(1);
    // Receipt file still present.
    expect(fs.readdirSync(deliveredDir())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mixed batch
// ---------------------------------------------------------------------------

describe('pruneDeliveredReceipts — mixed batch', () => {
  it('prunes only stale receipts with no surviving pending source', async () => {
    const { pruneDeliveredReceipts, DELIVERED_RECEIPT_MAX_AGE_MS } = await getRetention();

    const nowMs = 20_000_000;
    const staleAge = DELIVERED_RECEIPT_MAX_AGE_MS + 1_000;
    const freshAge = DELIVERED_RECEIPT_MAX_AGE_MS / 2;

    // (1) stale + acked + no pending source → should be pruned
    const goneFilename = writeDeliveredReceipt('msg-gone', '2026-10-01T00:00:00.010Z', nowMs - staleAge);
    // Write ack marker so the retention sweep treats this as safely delivered.
    writeAckMarker(goneFilename);

    // (2) stale + has pending source → must be kept (claim-authority invariant)
    const pendingFilename = writeDeliveredReceipt(
      'msg-pending', '2026-10-01T00:00:00.011Z', nowMs - staleAge,
    );
    writePendingSource(pendingFilename);

    // (3) fresh → kept by mtime guard
    writeDeliveredReceipt('msg-recent', '2026-10-01T00:00:00.012Z', nowMs - freshAge);

    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 0,
      minIntervalMs: 0,
      now: () => nowMs,
    });

    expect(result.ran).toBe(true);
    expect(result.pruned).toBe(1);
    expect(result.skippedHasPending).toBe(1);
    expect(result.skippedFresh).toBe(1);
    expect(result.skippedUnacked).toBe(0);

    const remaining = fs.readdirSync(deliveredDir()).filter(f => f !== 'acked').sort();
    expect(remaining).toHaveLength(2);
    // The pruned file is gone; the other two remain.
    expect(remaining.every((f) => !f.includes('msg-gone'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('pruneDeliveredReceipts — no delivered/ directory', () => {
  it('returns pruned=0 and does not throw when delivered/ does not exist', async () => {
    const { pruneDeliveredReceipts } = await getRetention();
    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 0,
      minIntervalMs: 0,
      now: () => Date.now(),
    });
    expect(result.ran).toBe(true);
    expect(result.pruned).toBe(0);
  });
});

describe('pruneDeliveredReceipts — .tmp- files skipped', () => {
  it('never touches .tmp- partial-write files in delivered/', async () => {
    const { pruneDeliveredReceipts, DELIVERED_RECEIPT_MAX_AGE_MS } = await getRetention();

    const nowMs = 10_000_000;
    fs.mkdirSync(deliveredDir(), { recursive: true });

    // Create a stale .tmp- file.
    const tmpFile = path.join(deliveredDir(), '.tmp-partial');
    fs.writeFileSync(tmpFile, '{}');
    const oldDate = new Date(nowMs - DELIVERED_RECEIPT_MAX_AGE_MS - 1_000);
    fs.utimesSync(tmpFile, oldDate, oldDate);

    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 0,
      minIntervalMs: 0,
      now: () => nowMs,
    });

    expect(result.pruned).toBe(0);
    // .tmp- file still present (not touched by retention).
    expect(fs.existsSync(tmpFile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constant derivation
// ---------------------------------------------------------------------------

describe('pruneDeliveredReceipts — DELIVERED_RECEIPT_MAX_AGE_MS derivation', () => {
  it('threshold is greater than the wake-budget window', async () => {
    const { DELIVERED_RECEIPT_MAX_AGE_MS } = await getRetention();
    const { PEER_WAKE_BUDGET_WINDOW_MS } = await import('./guards.js');
    // The retention window must extend beyond the wake-budget window so
    // findDeliveredEnvelope can still look up receipts for recently-replied
    // envelopes.
    expect(DELIVERED_RECEIPT_MAX_AGE_MS).toBeGreaterThan(PEER_WAKE_BUDGET_WINDOW_MS);
  });
});

// ---------------------------------------------------------------------------
// Guard/rate behaviour unchanged
// ---------------------------------------------------------------------------

describe('pruneDeliveredReceipts — guard/rate behaviour unchanged', () => {
  it('checkSendGuards still sees delivered receipts within the rate window', async () => {
    // Receipts within RATE_WINDOW_MS (60 s) must not be pruned — they are far
    // fresher than DELIVERED_RECEIPT_MAX_AGE_MS (> 1 h). This verifies that
    // the retention feature does not regress the rate-limit scanner in guards.ts.
    const { pruneDeliveredReceipts, DELIVERED_RECEIPT_MAX_AGE_MS } = await getRetention();

    const nowMs = 10_000_000;
    // Write a receipt that is 30 s old — within the 60 s dedup/rate window.
    writeDeliveredReceipt('msg-rate-window', '2026-10-01T00:00:00.020Z', nowMs - 30_000);

    const result = await pruneDeliveredReceipts({
      sessionId: SESSION_ID,
      lastRanMs: 0,
      minIntervalMs: 0,
      now: () => nowMs,
    });

    // Receipt must NOT be pruned — it is far newer than DELIVERED_RECEIPT_MAX_AGE_MS.
    expect(result.pruned).toBe(0);
    expect(result.skippedFresh).toBe(1);
    expect(fs.readdirSync(deliveredDir())).toHaveLength(1);
    // Sanity-check: DELIVERED_RECEIPT_MAX_AGE_MS >> 30_000.
    expect(DELIVERED_RECEIPT_MAX_AGE_MS).toBeGreaterThan(30_000);
  });
});
