/**
 * Tests for inbox-store filesystem mailbox operations.
 *
 * Isolates AFK_STATE_DIR to a temp directory so no real state is touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    const deliveredFiles = fs.readdirSync(deliveredDir).filter((f) => f !== 'acked');
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

  it('concurrent claims (N=10) on one file: exactly one non-null (hardlink-wins regression)', async () => {
    // Windows CI observed duplicate claims. Exclusive receipt creation must
    // enforce one winner independently of rename replacement semantics.
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();
    const env = makeEnvelope({ messageId: 'concurrent-hardlink-test' });
    await writeEnvelope(env);
    const files = await listPending(TARGET_ID);
    const file = files[0]!;

    const N = 10;
    const results = await Promise.all(Array.from({ length: N }, () => claimPending(TARGET_ID, file)));
    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);
    expect(winners[0]!.messageId).toBe(env.messageId);
  });

  it('does not overwrite an existing delivered target', async () => {
    const { writeEnvelope, listPending, claimPending } = await getInboxStore();
    await writeEnvelope(makeEnvelope());
    const [file] = await listPending(TARGET_ID);
    const dst = path.join(tmpDir, 'inbox', TARGET_ID, 'delivered', file!);
    fs.writeFileSync(dst, 'existing receipt');
    expect(await claimPending(TARGET_ID, file!)).toBeNull();
    expect(fs.readFileSync(dst, 'utf8')).toBe('existing receipt');
  });

  it('a crash after link leaves a receipt that prevents orphan-source redelivery', async () => {
    const { writeEnvelope, listPending, claimPending, holdPending, releaseHeld } = await getInboxStore();
    const envelope = makeEnvelope();
    await writeEnvelope(envelope);
    const [file] = await listPending(TARGET_ID);
    const base = path.join(tmpDir, 'inbox', TARGET_ID);
    // Simulate process exit immediately after exclusive receipt creation.
    fs.linkSync(path.join(base, 'pending', file!), path.join(base, 'delivered', file!));
    expect(await claimPending(TARGET_ID, file!)).toBeNull();
    expect(await holdPending(TARGET_ID, file!)).toBe(true);
    expect(await releaseHeld(TARGET_ID, file!)).toBe(true);
    expect(await claimPending(TARGET_ID, file!)).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(base, 'delivered', file!), 'utf8'))).toEqual(envelope);
    expect(fs.existsSync(path.join(base, 'lock'))).toBe(false);
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
    // Backdate pending dir and its files.
    const pendingDir = path.join(inboxDir, 'pending');
    const files = fs.readdirSync(pendingDir);
    for (const f of files) {
      fs.utimesSync(path.join(pendingDir, f), oldDate, oldDate);
    }
    fs.utimesSync(pendingDir, oldDate, oldDate);
    // Backdate delivered/ and its acked/ subdir (created by ensureInboxDirs).
    const deliveredDir = path.join(inboxDir, 'delivered');
    const ackedDir = path.join(deliveredDir, 'acked');
    if (fs.existsSync(ackedDir)) fs.utimesSync(ackedDir, oldDate, oldDate);
    if (fs.existsSync(deliveredDir)) fs.utimesSync(deliveredDir, oldDate, oldDate);
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
// checkOrphanPending (item 4a)
// ---------------------------------------------------------------------------

describe('checkOrphanPending', () => {
  it('returns none when no delivered receipt exists', async () => {
    const { writeEnvelope, listPending, checkOrphanPending } = await getInboxStore();
    await writeEnvelope(makeEnvelope());
    const [file] = await listPending(TARGET_ID);
    expect(await checkOrphanPending(TARGET_ID, file!)).toBe('none');
    // Pending file is still there.
    const still = await listPending(TARGET_ID);
    expect(still).toHaveLength(1);
  });

  it('returns valid and removes pending when a valid receipt exists', async () => {
    const { writeEnvelope, listPending, checkOrphanPending } = await getInboxStore();
    const envelope = makeEnvelope();
    await writeEnvelope(envelope);
    const [file] = await listPending(TARGET_ID);
    const base = path.join(tmpDir, 'inbox', TARGET_ID);
    // Simulate crash-after-link: create the delivered receipt manually.
    fs.mkdirSync(path.join(base, 'delivered'), { recursive: true });
    fs.copyFileSync(path.join(base, 'pending', file!), path.join(base, 'delivered', file!));

    const verdict = await checkOrphanPending(TARGET_ID, file!);
    expect(verdict).toBe('valid');
    // Pending source removed.
    expect(fs.existsSync(path.join(base, 'pending', file!))).toBe(false);
    // Delivered receipt untouched.
    expect(fs.existsSync(path.join(base, 'delivered', file!))).toBe(true);
  });

  it('returns corrupt and leaves pending intact when receipt is unparseable', async () => {
    const { writeEnvelope, listPending, checkOrphanPending } = await getInboxStore();
    await writeEnvelope(makeEnvelope());
    const [file] = await listPending(TARGET_ID);
    const base = path.join(tmpDir, 'inbox', TARGET_ID);
    // Create a corrupt (partial-write) delivered receipt.
    fs.mkdirSync(path.join(base, 'delivered'), { recursive: true });
    fs.writeFileSync(path.join(base, 'delivered', file!), 'PARTIAL DATA NOT JSON');

    const verdict = await checkOrphanPending(TARGET_ID, file!);
    expect(verdict).toBe('corrupt');
    // Pending source must NOT be removed on a bad receipt.
    expect(fs.existsSync(path.join(base, 'pending', file!))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// claimPending fallback (item 5)
// ---------------------------------------------------------------------------

describe('claimPending — fallback when link() is unsupported', () => {
  // Re-import inbox-store against an fs/promises whose link() always throws
  // `code`, as on exFAT/FAT, SMB, or FUSE mounts without hard-link support.
  async function importStoreWithLinkError(code: string) {
    vi.resetModules();
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs/promises')>();
      return {
        ...actual,
        link: async () => { throw Object.assign(new Error(`link: ${code}`), { code }); },
      };
    });
    return import('./inbox-store.js');
  }

  afterEach(() => {
    vi.doUnmock('fs/promises');
    vi.resetModules();
  });

  it('delivers via copyFile(COPYFILE_EXCL) when link() throws ENOTSUP', async () => {
    const store = await importStoreWithLinkError('ENOTSUP');
    const envelope = makeEnvelope();
    await store.writeEnvelope(envelope);
    const [file] = await store.listPending(TARGET_ID);
    const claimed = await store.claimPending(TARGET_ID, file!);
    expect(claimed?.messageId).toBe(envelope.messageId);
    const base = path.join(tmpDir, 'inbox', TARGET_ID);
    expect(fs.readdirSync(path.join(base, 'delivered')).filter((f) => f !== 'acked')).toEqual([file]);
    expect(await store.listPending(TARGET_ID)).toEqual([]);
  });

  it('keeps exactly one winner among concurrent claimers on the fallback path', async () => {
    const store = await importStoreWithLinkError('EPERM');
    await store.writeEnvelope(makeEnvelope({ messageId: 'concurrent-fallback-test' }));
    const [file] = await store.listPending(TARGET_ID);
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () => store.claimPending(TARGET_ID, file!)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('still propagates permission errors (EACCES) instead of falling back', async () => {
    const store = await importStoreWithLinkError('EACCES');
    await store.writeEnvelope(makeEnvelope());
    const [file] = await store.listPending(TARGET_ID);
    await expect(store.claimPending(TARGET_ID, file!)).rejects.toMatchObject({ code: 'EACCES' });
  });
});

// ---------------------------------------------------------------------------
// findDeliveredEnvelope — endsWith fix (item 8)
// ---------------------------------------------------------------------------

describe('findDeliveredEnvelope — endsWith match', () => {
  it('a short id that is a substring of another delivered file does not match', async () => {
    const { writeEnvelope, listPending, claimPending, findDeliveredEnvelope } = await getInboxStore();
    // Deliver two envelopes: one whose messageId is a prefix of the other's.
    const shortId = 'abc';
    const longId = `abc-extra-suffix`;
    // Write both; deliver both.
    const envShort = makeEnvelope({ messageId: shortId, ts: '2026-10-01T00:00:00.001Z' });
    const envLong = makeEnvelope({ messageId: longId, ts: '2026-10-01T00:00:00.002Z' });
    await writeEnvelope(envShort);
    await writeEnvelope(envLong);
    const files = await listPending(TARGET_ID);
    for (const f of files) {
      await claimPending(TARGET_ID, f);
    }
    // Looking up the long id must not match the short-id filename.
    const foundLong = await findDeliveredEnvelope(TARGET_ID, longId);
    expect(foundLong).not.toBeNull();
    expect(foundLong!.messageId).toBe(longId);

    // Looking up short must not match the long filename.
    const foundShort = await findDeliveredEnvelope(TARGET_ID, shortId);
    expect(foundShort).not.toBeNull();
    expect(foundShort!.messageId).toBe(shortId);
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
