/**
 * Tests for `scanPeerInbox` (peer-inbox-scan.ts).
 *
 * All filesystem operations use the sentinel AFK_HOME supplied by the global
 * redirect-paths-env.ts setup, so nothing touches the real ~/.afk.
 * Within each test we override AFK_HOME to an isolated mkdtemp so parallel
 * tests in the same file cannot share inbox directories.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, copyFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { scanPeerInbox } from './peer-inbox-scan.js';
import { writeEnvelope, listPending } from '../../../agent/peer/inbox-store.js';
import { createWakeBudget } from '../../../agent/peer/guards.js';
import type { PeerEnvelope } from '../../../agent/peer/envelope.js';

// Per-test override for claimPending; undefined = real implementation.
const claimOverride = vi.hoisted(() => ({
  fn: undefined as undefined | (() => Promise<PeerEnvelope | null>),
}));
vi.mock('../../../agent/peer/inbox-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../agent/peer/inbox-store.js')>();
  return {
    ...actual,
    claimPending: (...args: Parameters<typeof actual.claimPending>) =>
      claimOverride.fn ? claimOverride.fn() : actual.claimPending(...args),
  };
});

// ── path isolation ──────────────────────────────────────────────────────────
let tmpHome: string;
const prevHome: string | undefined = process.env['AFK_HOME'];

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'afk-scan-test-'));
  process.env['AFK_HOME'] = tmpHome;
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_FRAMEWORK_DIR'];
});

afterEach(async () => {
  if (prevHome !== undefined) process.env['AFK_HOME'] = prevHome;
  else delete process.env['AFK_HOME'];
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_FRAMEWORK_DIR'];
  await rm(tmpHome, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makeEnvelope(
  to: string,
  opts: Partial<Omit<PeerEnvelope, 'v' | 'to'>> = {},
): PeerEnvelope {
  return {
    v: 1,
    messageId: opts.messageId ?? randomUUID(),
    from: opts.from ?? { id: randomUUID() },
    to,
    hop: opts.hop ?? 0,
    ts: opts.ts ?? new Date().toISOString(),
    body: opts.body ?? 'hello',
    ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
  };
}

function unlimitedBudget() {
  return createWakeBudget({ perSenderPerHour: 10_000 });
}

function exhaustedBudget(senderId: string) {
  const b = createWakeBudget({ perSenderPerHour: 0 });
  // mark as already exhausted by overriding via a budget with limit=0:
  // tryConsume will always return false
  void senderId;
  return b;
}

describe('scanPeerInbox — mode=off', () => {
  it('returns empty result and claims nothing when mode is off', async () => {
    const sessionId = randomUUID();
    const env = makeEnvelope(sessionId);
    await writeEnvelope(env);

    const result = await scanPeerInbox({
      sessionId,
      mode: 'off',
      wakeBudget: unlimitedBudget(),
      capacity: 10,
    });

    expect(result.claimed).toHaveLength(0);
    expect(result.held).toHaveLength(0);
  });
});

describe('scanPeerInbox — mode=hold', () => {
  it('moves pending envelopes to held with reason inbound-hold', async () => {
    const sessionId = randomUUID();
    const env = makeEnvelope(sessionId);
    await writeEnvelope(env);

    const result = await scanPeerInbox({
      sessionId,
      mode: 'hold',
      wakeBudget: unlimitedBudget(),
      capacity: 10,
    });

    expect(result.claimed).toHaveLength(0);
    expect(result.held).toHaveLength(1);
    expect(result.held[0]?.reason).toBe('inbound-hold');
    expect(result.held[0]?.envelope.messageId).toBe(env.messageId);
  });
});

describe('scanPeerInbox — mode=accept', () => {
  it('claims pending envelopes in filename (chronological) order', async () => {
    const sessionId = randomUUID();
    // Write three envelopes with staggered timestamps so sort order is deterministic.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ts = new Date(Date.now() + i * 1000).toISOString();
      const e = makeEnvelope(sessionId, { messageId: randomUUID(), ts });
      ids.push(e.messageId);
      await writeEnvelope(e);
    }

    const result = await scanPeerInbox({
      sessionId,
      mode: 'accept',
      wakeBudget: unlimitedBudget(),
      capacity: 10,
    });

    expect(result.claimed).toHaveLength(3);
    expect(result.claimed.map((c) => c.messageId)).toEqual(ids);
  });

  it('over wake budget → held with reason wake-budget, NOT claimed', async () => {
    const sessionId = randomUUID();
    const senderId = randomUUID();
    const e = makeEnvelope(sessionId, { from: { id: senderId } });
    await writeEnvelope(e);

    // Budget limit = 0 → always fails
    const budget = createWakeBudget({ perSenderPerHour: 0 });

    const result = await scanPeerInbox({
      sessionId,
      mode: 'accept',
      wakeBudget: budget,
      capacity: 10,
    });

    expect(result.claimed).toHaveLength(0);
    expect(result.held).toHaveLength(1);
    expect(result.held[0]?.reason).toBe('wake-budget');
    expect(result.held[0]?.envelope.messageId).toBe(e.messageId);
  });

  it('capacity is respected — extra envelopes stay pending (not claimed or held)', async () => {
    const sessionId = randomUUID();
    for (let i = 0; i < 4; i++) {
      const ts = new Date(Date.now() + i * 1000).toISOString();
      await writeEnvelope(makeEnvelope(sessionId, { ts }));
    }

    const result = await scanPeerInbox({
      sessionId,
      mode: 'accept',
      wakeBudget: unlimitedBudget(),
      capacity: 2,
    });

    // Exactly 2 claimed; the rest stay pending (neither claimed nor held)
    expect(result.claimed).toHaveLength(2);
    expect(result.held).toHaveLength(0);
  });

  it('skips an unparseable file without stalling the rest of the inbox', async () => {
    const sessionId = randomUUID();
    // Write a valid envelope
    const good = makeEnvelope(sessionId);
    await writeEnvelope(good);

    // Inject a corrupt file directly into pending/
    // paths.ts re-evaluates based on AFK_HOME; import dynamically to pick up override
    const { getPeerInboxDir } = await import('../../../paths.js');
    const pendingDir = join(getPeerInboxDir(sessionId), 'pending');
    await mkdir(pendingDir, { recursive: true, mode: 0o700 });
    // timestamp prefix must sort before the good envelope so it is processed first
    const corruptTs = new Date(Date.now() - 5000).toISOString().replace(/[:.]/g, '-');
    await writeFile(
      join(pendingDir, `${corruptTs}-corrupt-file.json`),
      'THIS IS NOT JSON',
      { encoding: 'utf8', mode: 0o600 },
    );

    const result = await scanPeerInbox({
      sessionId,
      mode: 'accept',
      wakeBudget: unlimitedBudget(),
      capacity: 10,
    });

    // The corrupt file is skipped; the good one is claimed
    expect(result.claimed).toHaveLength(1);
    expect(result.claimed[0]?.messageId).toBe(good.messageId);
    expect(result.held).toHaveLength(0);
  });
});

// ── Orphan detection regression (item 4a) ───────────────────────────────────

describe('scanPeerInbox — orphan detection', () => {
  it('orphan with valid receipt: not claimed, not held, no budget spent, pending removed', async () => {
    const sessionId = randomUUID();
    const senderId = randomUUID();
    const env = makeEnvelope(sessionId, { from: { id: senderId } });
    await writeEnvelope(env);

    // Simulate crash-after-link: create the delivered receipt manually.
    const { getPeerInboxDir } = await import('../../../paths.js');
    const base = getPeerInboxDir(sessionId);
    const files = await listPending(sessionId);
    const file = files[0]!;
    await mkdir(join(base, 'delivered'), { recursive: true, mode: 0o700 });
    await copyFile(join(base, 'pending', file), join(base, 'delivered', file));

    // Budget with a limit of 1 so we can detect if a slot was consumed.
    const budget = createWakeBudget({ perSenderPerHour: 1 });

    const result = await scanPeerInbox({
      sessionId,
      mode: 'accept',
      wakeBudget: budget,
      capacity: 10,
    });

    // Orphan is silently discarded — no claim, no hold.
    expect(result.claimed).toHaveLength(0);
    expect(result.held).toHaveLength(0);

    // Budget must NOT have been consumed.
    // If it had been consumed, the next tryConsume (limit=1) would return false.
    expect(budget.tryConsume(senderId)).toBe(true);
  });

  it('orphan with corrupt receipt: not claimed, not held, pending preserved', async () => {
    const sessionId = randomUUID();
    const env = makeEnvelope(sessionId);
    await writeEnvelope(env);

    const { getPeerInboxDir } = await import('../../../paths.js');
    const base = getPeerInboxDir(sessionId);
    const files = await listPending(sessionId);
    const file = files[0]!;
    // Create a corrupt delivered receipt.
    await mkdir(join(base, 'delivered'), { recursive: true, mode: 0o700 });
    await writeFile(join(base, 'delivered', file), 'CORRUPT DATA', { mode: 0o600 });

    const result = await scanPeerInbox({
      sessionId,
      mode: 'accept',
      wakeBudget: unlimitedBudget(),
      capacity: 10,
    });

    expect(result.claimed).toHaveLength(0);
    expect(result.held).toHaveLength(0);

    // Pending source must still exist (corrupt receipt must not destroy content).
    const pendingAfter = await listPending(sessionId);
    expect(pendingAfter).toHaveLength(1);
  });
});

// ── Failed-claim budget refund regression (item 4b) ─────────────────────────

describe('scanPeerInbox — a failed claim does not consume budget', () => {
  afterEach(() => { claimOverride.fn = undefined; });

  async function scanWithFailingClaim(fail: () => Promise<PeerEnvelope | null>): Promise<boolean> {
    const sessionId = randomUUID();
    const senderId = randomUUID();
    await writeEnvelope(makeEnvelope(sessionId, { from: { id: senderId } }));
    const budget = createWakeBudget({ perSenderPerHour: 1 });
    claimOverride.fn = fail;
    const result = await scanPeerInbox({ sessionId, mode: 'accept', wakeBudget: budget, capacity: 10 });
    expect(result.claimed).toHaveLength(0);
    expect(result.held).toHaveLength(0);
    // limit=1: a leaked slot would make this return false.
    return budget.tryConsume(senderId);
  }

  it('refunds the slot when claimPending returns null (lost race)', async () => {
    expect(await scanWithFailingClaim(async () => null)).toBe(true);
  });

  it('refunds the slot when claimPending throws', async () => {
    expect(await scanWithFailingClaim(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); })).toBe(true);
  });
});
