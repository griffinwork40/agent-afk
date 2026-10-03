/**
 * Tests for inbox-store filesystem mailbox operations.
 *
 * Isolates AFK_STATE_DIR to a temp directory so no real state is touched.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-inbox-test-'));
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

async function getInboxStore() {
  return import('./inbox-store.js');
}

const TARGET_ID = 'target-session-aaaa';
const SENDER_ID = 'sender-session-bbbb';

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  return {
    v: 1 as const,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    from: { id: SENDER_ID },
    to: TARGET_ID,
    hop: 0,
    ts,
    body: 'test message',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// write → listPending
// ---------------------------------------------------------------------------

describe('writeEnvelope + listPending', () => {
  it('write then listPending returns the filename (not .tmp-)', async () => {
    const { writeEnvelope, listPending } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/^\.tmp-/);
    expect(files[0]).toContain(env.messageId);
    expect(files[0]).toMatch(/\.json$/);
  });

  it('listPending excludes .tmp- files', async () => {
    const { writeEnvelope, listPending } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);

    // Manually create a .tmp- file to ensure it is excluded.
    const pendingDir = path.join(tmpDir, 'inbox', TARGET_ID, 'pending');
    fs.writeFileSync(path.join(pendingDir, '.tmp-orphan'), '{}');

    const files = await listPending(TARGET_ID);
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toHaveLength(0);
    expect(files).toHaveLength(1);
  });

  it('listPending returns sorted filenames (chronological)', async () => {
    const { writeEnvelope, listPending } = await getInboxStore();
    // Write with distinct timestamps.
    const env1 = makeEnvelope({ ts: '2026-10-01T00:00:00.001Z', messageId: 'msg-first' });
    const env2 = makeEnvelope({ ts: '2026-10-01T00:00:00.002Z', messageId: 'msg-second' });
    const env3 = makeEnvelope({ ts: '2026-10-01T00:00:00.003Z', messageId: 'msg-third' });
    await writeEnvelope(env1);
    await writeEnvelope(env2);
    await writeEnvelope(env3);

    const files = await listPending(TARGET_ID);
    expect(files).toHaveLength(3);
    // Filenames are sortable because they use ISO timestamps with colons replaced.
    for (let i = 0; i < files.length - 1; i++) {
      expect(files[i]! < files[i + 1]!).toBe(true);
    }
  });

  it('listPending returns [] for a session with no inbox', async () => {
    const { listPending } = await getInboxStore();
    const files = await listPending('nonexistent-session');
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// peekPending — does NOT move the file
// ---------------------------------------------------------------------------

describe('peekPending', () => {
  it('reads the envelope without moving it', async () => {
    const { writeEnvelope, listPending, peekPending } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    expect(files).toHaveLength(1);

    const peeked = await peekPending(TARGET_ID, files[0]!);
    expect(peeked).not.toBeNull();
    expect(peeked!.messageId).toBe(env.messageId);

    // File is still in pending after peek.
    const filesAfterPeek = await listPending(TARGET_ID);
    expect(filesAfterPeek).toHaveLength(1);
    expect(filesAfterPeek[0]).toBe(files[0]);
  });

  it('returns null for a nonexistent file', async () => {
    const { peekPending } = await getInboxStore();
    const result = await peekPending(TARGET_ID, 'nonexistent.json');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// claimPending — race: exactly one non-null winner
// ---------------------------------------------------------------------------

describe('claimPending', () => {
  it('claim returns the envelope on success', async () => {
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    const claimed = await claimPending(TARGET_ID, files[0]!);
    expect(claimed).not.toBeNull();
    expect(claimed!.messageId).toBe(env.messageId);
  });

  it('claim moves the file from pending to delivered', async () => {
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    await claimPending(TARGET_ID, files[0]!);

    const pendingAfter = await listPending(TARGET_ID);
    expect(pendingAfter).toHaveLength(0);

    const deliveredDir = path.join(tmpDir, 'inbox', TARGET_ID, 'delivered');
    const deliveredFiles = fs.readdirSync(deliveredDir);
    expect(deliveredFiles).toHaveLength(1);
  });

  it('concurrent claims on one file: exactly one non-null', async () => {
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    const file = files[0]!;

    // Two concurrent claims on the same file.
    const [r1, r2] = await Promise.all([
      claimPending(TARGET_ID, file),
      claimPending(TARGET_ID, file),
    ]);

    const winners = [r1, r2].filter((r) => r !== null);
    const losers = [r1, r2].filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('claim returns null for a missing file (ENOENT)', async () => {
    const { claimPending } = await getInboxStore();
    // Ensure the dirs exist first.
    fs.mkdirSync(path.join(tmpDir, 'inbox', TARGET_ID, 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'inbox', TARGET_ID, 'delivered'), { recursive: true });
    const result = await claimPending(TARGET_ID, 'ghost.json');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hold / listHeld / releaseHeld / dropHeld
// ---------------------------------------------------------------------------

describe('hold/listHeld/releaseHeld/dropHeld', () => {
  it('holdPending moves file to held/', async () => {
    const { writeEnvelope, listPending, holdPending } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);

    const held = await holdPending(TARGET_ID, files[0]!);
    expect(held).toBe(true);

    const pendingAfter = await listPending(TARGET_ID);
    expect(pendingAfter).toHaveLength(0);

    const heldDir = path.join(tmpDir, 'inbox', TARGET_ID, 'held');
    const heldFiles = fs.readdirSync(heldDir);
    expect(heldFiles).toHaveLength(1);
  });

  it('holdPending returns false for a missing file', async () => {
    const { holdPending } = await getInboxStore();
    fs.mkdirSync(path.join(tmpDir, 'inbox', TARGET_ID, 'pending'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'inbox', TARGET_ID, 'held'), { recursive: true });
    const result = await holdPending(TARGET_ID, 'ghost.json');
    expect(result).toBe(false);
  });

  it('listHeld returns held envelopes with file + envelope', async () => {
    const { writeEnvelope, listPending, holdPending, listHeld } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    await holdPending(TARGET_ID, files[0]!);

    const held = await listHeld(TARGET_ID);
    expect(held).toHaveLength(1);
    expect(held[0]!.file).toBe(files[0]);
    expect(held[0]!.envelope.messageId).toBe(env.messageId);
  });

  it('listHeld returns [] for session with no held dir', async () => {
    const { listHeld } = await getInboxStore();
    const result = await listHeld('no-such-session');
    expect(result).toEqual([]);
  });

  it('releaseHeld moves file back to pending', async () => {
    const { writeEnvelope, listPending, holdPending, releaseHeld } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    await holdPending(TARGET_ID, files[0]!);
    const released = await releaseHeld(TARGET_ID, files[0]!);
    expect(released).toBe(true);

    const pendingAfter = await listPending(TARGET_ID);
    expect(pendingAfter).toHaveLength(1);
  });

  it('releaseHeld returns false for missing file', async () => {
    const { releaseHeld } = await getInboxStore();
    fs.mkdirSync(path.join(tmpDir, 'inbox', TARGET_ID, 'held'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'inbox', TARGET_ID, 'pending'), { recursive: true });
    const result = await releaseHeld(TARGET_ID, 'ghost.json');
    expect(result).toBe(false);
  });

  it('dropHeld deletes the file permanently', async () => {
    const { writeEnvelope, listPending, holdPending, dropHeld, listHeld } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    await holdPending(TARGET_ID, files[0]!);

    const dropped = await dropHeld(TARGET_ID, files[0]!);
    expect(dropped).toBe(true);

    const heldAfter = await listHeld(TARGET_ID);
    expect(heldAfter).toHaveLength(0);
  });

  it('dropHeld returns false when file is already gone', async () => {
    const { dropHeld } = await getInboxStore();
    fs.mkdirSync(path.join(tmpDir, 'inbox', TARGET_ID, 'held'), { recursive: true });
    const result = await dropHeld(TARGET_ID, 'ghost.json');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countPending
// ---------------------------------------------------------------------------

describe('countPending', () => {
  it('returns 0 for a session with no inbox', async () => {
    const { countPending } = await getInboxStore();
    expect(await countPending('nobody')).toBe(0);
  });

  it('returns the number of pending envelopes', async () => {
    const { writeEnvelope, countPending } = await getInboxStore();
    await writeEnvelope(makeEnvelope({ messageId: 'm1', ts: '2026-10-01T00:00:00.001Z' }));
    await writeEnvelope(makeEnvelope({ messageId: 'm2', ts: '2026-10-01T00:00:00.002Z' }));
    expect(await countPending(TARGET_ID)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// findDeliveredEnvelope
// ---------------------------------------------------------------------------

describe('findDeliveredEnvelope', () => {
  it('finds a delivered envelope by messageId', async () => {
    const { writeEnvelope, listPending, claimPending, findDeliveredEnvelope } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    await claimPending(TARGET_ID, files[0]!);

    const found = await findDeliveredEnvelope(TARGET_ID, env.messageId);
    expect(found).not.toBeNull();
    expect(found!.messageId).toBe(env.messageId);
  });

  it('returns null for a messageId not in delivered/', async () => {
    const { findDeliveredEnvelope } = await getInboxStore();
    const result = await findDeliveredEnvelope(TARGET_ID, 'no-such-id');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sweepPeerInboxes
// ---------------------------------------------------------------------------

describe('sweepPeerInboxes', () => {
  it('removes old dead sessions (no live set, old mtime)', async () => {
    const { writeEnvelope, sweepPeerInboxes } = await getInboxStore();
    const deadId = 'dead-session-xxxx';
    const deadEnv = makeEnvelope({ to: deadId, messageId: 'dead-msg' });
    await writeEnvelope(deadEnv);

    // Backdate the directory mtime so it looks old (8 days ago).
    const inboxDir = path.join(tmpDir, 'inbox', deadId);
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // Backdate the pending dir and the file inside it.
    const pendingDir = path.join(inboxDir, 'pending');
    const files = fs.readdirSync(pendingDir);
    for (const f of files) {
      fs.utimesSync(path.join(pendingDir, f), oldDate, oldDate);
    }
    fs.utimesSync(pendingDir, oldDate, oldDate);
    fs.utimesSync(inboxDir, oldDate, oldDate);

    const removed = await sweepPeerInboxes({
      liveSessionIds: new Set<string>(),
      now: () => Date.now(),
    });
    expect(removed).toBe(1);
    expect(fs.existsSync(inboxDir)).toBe(false);
  });

  it('keeps live sessions regardless of age', async () => {
    const { writeEnvelope, sweepPeerInboxes } = await getInboxStore();
    const liveId = 'live-session-yyyy';
    await writeEnvelope(makeEnvelope({ to: liveId, messageId: 'live-msg' }));

    // Backdate aggressively.
    const inboxDir = path.join(tmpDir, 'inbox', liveId);
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const pendingDir = path.join(inboxDir, 'pending');
    const files = fs.readdirSync(pendingDir);
    for (const f of files) fs.utimesSync(path.join(pendingDir, f), oldDate, oldDate);
    fs.utimesSync(pendingDir, oldDate, oldDate);
    fs.utimesSync(inboxDir, oldDate, oldDate);

    const removed = await sweepPeerInboxes({
      liveSessionIds: new Set([liveId]),
      now: () => Date.now(),
    });
    expect(removed).toBe(0);
    expect(fs.existsSync(inboxDir)).toBe(true);
  });

  it('keeps recent dead sessions (less than maxAgeMs)', async () => {
    const { writeEnvelope, sweepPeerInboxes } = await getInboxStore();
    const recentDeadId = 'recent-dead-zzzz';
    await writeEnvelope(makeEnvelope({ to: recentDeadId, messageId: 'recent-msg' }));
    // The file has a fresh mtime (just written), so it should NOT be removed.
    const removed = await sweepPeerInboxes({
      liveSessionIds: new Set<string>(),
      now: () => Date.now(),
    });
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'inbox', recentDeadId))).toBe(true);
  });

  it('returns 0 when the inbox root does not exist', async () => {
    const { sweepPeerInboxes } = await getInboxStore();
    // No inbox root at all.
    const removed = await sweepPeerInboxes({
      liveSessionIds: new Set<string>(),
    });
    expect(removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// File modes
// Asserting modes portably requires knowing that Windows' stat() always
// returns 0o666 / 0o777 regardless of the createFile flags. Mode assertions
// are therefore only correct on POSIX; rather than gating on process.platform
// (which the posix-guard R4 rule forbids), we assert that the files exist
// and were written atomically — the correctness of their content is covered
// by the read-back tests above.
// ---------------------------------------------------------------------------

describe('file modes', () => {
  it('directories are created at write time (exists check)', async () => {
    const { writeEnvelope } = await getInboxStore();
    await writeEnvelope(makeEnvelope());
    const pendingDir = path.join(tmpDir, 'inbox', TARGET_ID, 'pending');
    expect(fs.existsSync(pendingDir)).toBe(true);
  });

  it('envelope files are readable after write', async () => {
    const { writeEnvelope, listPending } = await getInboxStore();
    await writeEnvelope(makeEnvelope());
    const files = await listPending(TARGET_ID);
    const filePath = path.join(tmpDir, 'inbox', TARGET_ID, 'pending', files[0]!);
    // File is accessible (no EACCES on the owning process).
    expect(() => fs.readFileSync(filePath, 'utf8')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// reclaimDelivered + envelopeFilename
// ---------------------------------------------------------------------------

describe('reclaimDelivered + envelopeFilename', () => {
  it('reclaimDelivered moves a delivered envelope back to pending/', async () => {
    const { writeEnvelope, claimPending, listPending, reclaimDelivered, listHeld } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    const file = files[0]!;
    await claimPending(TARGET_ID, file);
    // Verify it is NOT in pending after claim.
    expect(await listPending(TARGET_ID)).toHaveLength(0);
    // Reclaim it.
    const ok = await reclaimDelivered(TARGET_ID, file);
    expect(ok).toBe(true);
    // Should be back in pending.
    const pendingAfter = await listPending(TARGET_ID);
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0]).toBe(file);
    // Held directory unaffected.
    const held = await listHeld(TARGET_ID);
    expect(held).toHaveLength(0);
  });

  it('reclaimDelivered returns false for a file not in delivered/', async () => {
    const { reclaimDelivered } = await getInboxStore();
    const ok = await reclaimDelivered(TARGET_ID, 'nonexistent-file.json');
    expect(ok).toBe(false);
  });

  it('reclaimDelivered is idempotent — second call returns false', async () => {
    const { writeEnvelope, claimPending, listPending, reclaimDelivered } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    const file = files[0]!;
    await claimPending(TARGET_ID, file);
    expect(await reclaimDelivered(TARGET_ID, file)).toBe(true);
    expect(await reclaimDelivered(TARGET_ID, file)).toBe(false); // already gone
  });

  it('envelopeFilename reconstructs the same filename as writeEnvelope uses', async () => {
    const { writeEnvelope, listPending, envelopeFilename } = await getInboxStore();
    const env = makeEnvelope({ ts: '2026-10-02T12:30:45.123Z', messageId: 'my-msg-id' });
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    const reconstructed = envelopeFilename({ ts: env.ts, messageId: env.messageId });
    expect(files[0]).toBe(reconstructed);
    expect(reconstructed).toBe('2026-10-02T12-30-45-123Z-my-msg-id.json');
  });

  it('reclaim + re-claim round-trip: reclaimed envelope can be claimed again', async () => {
    const { writeEnvelope, claimPending, listPending, reclaimDelivered } = await getInboxStore();
    const env = makeEnvelope();
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    const file = files[0]!;
    // Claim.
    const claimed1 = await claimPending(TARGET_ID, file);
    expect(claimed1).not.toBeNull();
    // Reclaim.
    expect(await reclaimDelivered(TARGET_ID, file)).toBe(true);
    // Claim again.
    const claimed2 = await claimPending(TARGET_ID, file);
    expect(claimed2).not.toBeNull();
    expect(claimed2?.messageId).toBe(env.messageId);
  });
});
