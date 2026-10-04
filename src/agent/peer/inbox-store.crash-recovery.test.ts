/**
 * Tests for crash-recovery (injection-ack) protocol in inbox-store.
 *
 * Covers:
 *   - Crash between claim and inject: recovered on restart.
 *   - Already-injected messages (ack marker present): not reclaimed.
 *   - Cross-session safety: unrelated session envelopes are never reclaimed.
 *   - Multiple envelopes in a batch: none disappear silently after crash.
 *   - Concurrent / duplicate recovery: idempotent.
 *   - writeInjectionAck is a no-op on error (does not throw).
 *   - recoverUnackedDelivered returns [] when no delivered/ dir exists.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-inbox-crash-test-'));
  origStateDir = process.env['AFK_STATE_DIR']; // audit-env-access: allow (test isolation)
  process.env['AFK_STATE_DIR'] = tmpDir; // audit-env-access: allow (test isolation)
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origStateDir === undefined) {
    delete process.env['AFK_STATE_DIR']; // audit-env-access: allow (test isolation)
  } else {
    process.env['AFK_STATE_DIR'] = origStateDir; // audit-env-access: allow (test isolation)
  }
});

async function getInboxStore() {
  return import('./inbox-store.js');
}

const TARGET_ID = 'target-session-crash-test-aaaa';
const OTHER_ID = 'other-session-crash-test-bbbb';
const SENDER_ID = 'sender-session-crash-test-cccc';

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  return {
    v: 1 as const,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    from: { id: SENDER_ID },
    to: TARGET_ID,
    hop: 0,
    ts,
    body: 'crash-recovery test message',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// recoverUnackedDelivered --- crash between claim and inject
// ---------------------------------------------------------------------------

describe('recoverUnackedDelivered -- crash between claim and inject', () => {
  it('reclaims a claimed-but-uninjected envelope back to pending/', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      recoverUnackedDelivered,
    } = await getInboxStore();

    const env = makeEnvelope();
    await writeEnvelope(env);
    const [file] = await listPending(TARGET_ID);
    expect(file).toBeDefined();

    // Process "crashes" after claim but before writeInjectionAck.
    await claimPending(TARGET_ID, file!);
    expect(await listPending(TARGET_ID)).toHaveLength(0);

    // Simulate restart: recover unacked delivered.
    const recovered = await recoverUnackedDelivered(TARGET_ID);
    expect(recovered).toEqual([file]);

    // Envelope is back in pending and can be claimed again.
    const pendingAfter = await listPending(TARGET_ID);
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0]).toBe(file);
  });

  it('reclaimed envelope round-trips: claimPending succeeds after recovery', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      recoverUnackedDelivered,
    } = await getInboxStore();

    const env = makeEnvelope();
    await writeEnvelope(env);
    const [file] = await listPending(TARGET_ID);
    await claimPending(TARGET_ID, file!);

    await recoverUnackedDelivered(TARGET_ID);

    // Can be claimed again after recovery.
    const claimed = await claimPending(TARGET_ID, file!);
    expect(claimed).not.toBeNull();
    expect(claimed!.messageId).toBe(env.messageId);
  });
});

// ---------------------------------------------------------------------------
// writeInjectionAck + recoverUnackedDelivered --- acked messages not reclaimed
// ---------------------------------------------------------------------------

describe('writeInjectionAck -- already-injected messages not reclaimed', () => {
  it('does not reclaim an envelope that has been acked', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      writeInjectionAck,
      recoverUnackedDelivered,
    } = await getInboxStore();

    const env = makeEnvelope();
    await writeEnvelope(env);
    const [file] = await listPending(TARGET_ID);
    await claimPending(TARGET_ID, file!);
    await writeInjectionAck(TARGET_ID, file!);

    // Simulate restart: acked envelope should NOT be reclaimed.
    const recovered = await recoverUnackedDelivered(TARGET_ID);
    expect(recovered).toEqual([]);

    // Pending should remain empty.
    expect(await listPending(TARGET_ID)).toHaveLength(0);
  });

  it('ack marker is written to delivered/acked/<file>', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      writeInjectionAck,
    } = await getInboxStore();

    const env = makeEnvelope();
    await writeEnvelope(env);
    const [file] = await listPending(TARGET_ID);
    await claimPending(TARGET_ID, file!);
    await writeInjectionAck(TARGET_ID, file!);

    const ackedPath = path.join(tmpDir, 'inbox', TARGET_ID, 'delivered', 'acked', file!);
    expect(fs.existsSync(ackedPath)).toBe(true);
    expect(fs.readFileSync(ackedPath, 'utf8')).toBe(TARGET_ID);
  });

  it('writeInjectionAck does not throw on a non-existent session', async () => {
    const { writeInjectionAck } = await getInboxStore();
    await expect(writeInjectionAck('nonexistent-session', 'ghost.json')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-session safety: unrelated session envelopes never reclaimed
// ---------------------------------------------------------------------------

describe('recoverUnackedDelivered -- cross-session safety', () => {
  it('does not reclaim envelopes whose to field belongs to another session', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      recoverUnackedDelivered,
    } = await getInboxStore();

    // Write an envelope for OTHER_ID and deliver it to OTHER_ID's inbox.
    const env = makeEnvelope({ to: OTHER_ID });
    await writeEnvelope(env);
    const [fileOther] = await listPending(OTHER_ID);
    await claimPending(OTHER_ID, fileOther!);

    // Manually copy OTHER_ID's receipt into TARGET_ID's delivered/.
    const otherDeliveredDir = path.join(tmpDir, 'inbox', OTHER_ID, 'delivered');
    const targetDeliveredDir = path.join(tmpDir, 'inbox', TARGET_ID, 'delivered');
    fs.mkdirSync(targetDeliveredDir, { recursive: true });
    fs.copyFileSync(
      path.join(otherDeliveredDir, fileOther!),
      path.join(targetDeliveredDir, fileOther!),
    );

    // Recovering TARGET_ID must NOT reclaim OTHER_ID's envelope (to != TARGET_ID).
    const recovered = await recoverUnackedDelivered(TARGET_ID);
    expect(recovered).toEqual([]);
  });

  it('recovering session A does not affect session B pending', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      recoverUnackedDelivered,
    } = await getInboxStore();

    const envTarget = makeEnvelope({ to: TARGET_ID });
    const envOther = makeEnvelope({ to: OTHER_ID });
    await writeEnvelope(envTarget);
    await writeEnvelope(envOther);

    const [fileTarget] = await listPending(TARGET_ID);
    const [fileOther] = await listPending(OTHER_ID);

    await claimPending(TARGET_ID, fileTarget!);
    await claimPending(OTHER_ID, fileOther!);

    // Recover only TARGET_ID.
    const recovered = await recoverUnackedDelivered(TARGET_ID);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toBe(fileTarget);

    // OTHER_ID's delivered/ is untouched.
    expect(await listPending(OTHER_ID)).toHaveLength(0);
    const otherDeliveredDir = path.join(tmpDir, 'inbox', OTHER_ID, 'delivered');
    const otherDelivered = fs.readdirSync(otherDeliveredDir).filter(
      (f) => f !== 'acked' && !f.startsWith('.tmp-'),
    );
    expect(otherDelivered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Batch crash: multiple claimed envelopes, none lost
// ---------------------------------------------------------------------------

describe('recoverUnackedDelivered -- batch crash recovery', () => {
  it('recovers all claimed-but-unacked envelopes in a batch', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      recoverUnackedDelivered,
    } = await getInboxStore();

    const msgs = [
      makeEnvelope({ messageId: 'batch-1', ts: '2026-10-01T00:00:00.001Z' }),
      makeEnvelope({ messageId: 'batch-2', ts: '2026-10-01T00:00:00.002Z' }),
      makeEnvelope({ messageId: 'batch-3', ts: '2026-10-01T00:00:00.003Z' }),
    ];
    for (const env of msgs) await writeEnvelope(env);

    const files = await listPending(TARGET_ID);
    expect(files).toHaveLength(3);
    for (const f of files) await claimPending(TARGET_ID, f);

    const recovered = await recoverUnackedDelivered(TARGET_ID);
    expect(recovered).toHaveLength(3);

    const pendingAfter = await listPending(TARGET_ID);
    expect(pendingAfter).toHaveLength(3);
  });

  it('partially acked batch: only unacked envelopes are recovered', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      writeInjectionAck,
      recoverUnackedDelivered,
    } = await getInboxStore();

    const msgs = [
      makeEnvelope({ messageId: 'partial-1', ts: '2026-10-01T00:00:00.001Z' }),
      makeEnvelope({ messageId: 'partial-2', ts: '2026-10-01T00:00:00.002Z' }),
      makeEnvelope({ messageId: 'partial-3', ts: '2026-10-01T00:00:00.003Z' }),
    ];
    for (const env of msgs) await writeEnvelope(env);

    const files = await listPending(TARGET_ID);
    expect(files).toHaveLength(3);
    for (const f of files) await claimPending(TARGET_ID, f);

    // Ack only the first two; third is "crashed before ack".
    await writeInjectionAck(TARGET_ID, files[0]!);
    await writeInjectionAck(TARGET_ID, files[1]!);

    const recovered = await recoverUnackedDelivered(TARGET_ID);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toBe(files[2]);

    const pendingAfter = await listPending(TARGET_ID);
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0]).toBe(files[2]);
  });
});

// ---------------------------------------------------------------------------
// recoverUnackedDelivered -- edge cases
// ---------------------------------------------------------------------------

describe('recoverUnackedDelivered -- edge cases', () => {
  it('returns [] when delivered/ does not exist', async () => {
    const { recoverUnackedDelivered } = await getInboxStore();
    const result = await recoverUnackedDelivered('no-such-session');
    expect(result).toEqual([]);
  });

  it('idempotent: second call returns [] (already reclaimed)', async () => {
    const {
      writeEnvelope,
      listPending,
      claimPending,
      recoverUnackedDelivered,
    } = await getInboxStore();

    const env = makeEnvelope();
    await writeEnvelope(env);
    const [file] = await listPending(TARGET_ID);
    await claimPending(TARGET_ID, file!);

    await recoverUnackedDelivered(TARGET_ID);
    const secondPass = await recoverUnackedDelivered(TARGET_ID);
    expect(secondPass).toEqual([]);
  });

  it('skips corrupt receipts (unparseable JSON) without throwing', async () => {
    const { recoverUnackedDelivered } = await getInboxStore();

    const deliveredDir = path.join(tmpDir, 'inbox', TARGET_ID, 'delivered');
    fs.mkdirSync(deliveredDir, { recursive: true });
    fs.writeFileSync(path.join(deliveredDir, '2026-10-01T00-00-00-001Z-bad.json'), 'NOT JSON');

    const result = await recoverUnackedDelivered(TARGET_ID);
    expect(result).toEqual([]);
    // Corrupt file is left in place.
    expect(fs.existsSync(path.join(deliveredDir, '2026-10-01T00-00-00-001Z-bad.json'))).toBe(true);
  });
});
