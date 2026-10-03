/**
 * Tests for per-provider+account admission buckets and cross-process backoff
 * (rate-limit-bucket.registry.ts + the bucket's peer adoption).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PEER_SYNC_INTERVAL_MS,
  RateLimitBucket,
  globalRateLimitBucket,
  type PeerRateLimitObservation,
} from './rate-limit-bucket.js';
import { getRateLimitBucket, resetRateLimitBucketsForTests } from './rate-limit-bucket.registry.js';
import { publishingGate, resetUsageLedgerForTests } from '../../usage/usage-ledger.js';
import { StateStore } from '../../state/state-store.js';
import { getStateDatabasePath } from '../../../paths.js';

/** Resolves true when acquirePermit returned before `ms` (not blocked), false when it was still waiting. */
async function admitsWithin(bucket: RateLimitBucket, ms: number): Promise<boolean> {
  const ctrl = new AbortController();
  let admitted = false;
  const p = bucket.acquirePermit(1, ctrl.signal).then(() => { admitted = true; });
  await new Promise((r) => setTimeout(r, ms));
  const result = admitted;
  ctrl.abort();
  await p;
  return result;
}

let dir: string;
let savedHome: string | undefined;

beforeEach(() => {
  process.env['AFK_RATE_LIMIT_STAGGER_MAX_MS'] = '0';
  delete process.env['AFK_RATE_LIMIT_ADMISSION_DISABLED'];
  dir = mkdtempSync(join(tmpdir(), 'afk-rl-registry-'));
  savedHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = dir;
  resetUsageLedgerForTests();
  resetRateLimitBucketsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env['AFK_RATE_LIMIT_STAGGER_MAX_MS'];
  resetUsageLedgerForTests();
  resetRateLimitBucketsForTests();
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('getRateLimitBucket — key separation', () => {
  it('returns one stable bucket per provider+account, distinct across keys', () => {
    const a = getRateLimitBucket('anthropic', 'oauth');
    expect(getRateLimitBucket('anthropic', 'oauth')).toBe(a);
    expect(getRateLimitBucket('anthropic', 'api-key')).not.toBe(a);
    expect(getRateLimitBucket('openai', 'api.openai.com')).not.toBe(a);
    expect(a).not.toBe(globalRateLimitBucket);
  });

  it('an exhausted OpenAI bucket does not block Anthropic admission', async () => {
    const openai = getRateLimitBucket('openai', 'api.openai.com');
    const anthropic = getRateLimitBucket('anthropic', 'oauth');
    openai.update({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000 });
    anthropic.update({ requestsRemaining: 50 });
    expect(await admitsWithin(anthropic, 30)).toBe(true);
    expect(await admitsWithin(openai, 30)).toBe(false);
  });

  it('a freeze on one key leaves the others admitting', async () => {
    getRateLimitBucket('anthropic', 'oauth').freeze(60_000);
    expect(await admitsWithin(getRateLimitBucket('openai', 'api.openai.com'), 30)).toBe(true);
    expect(await admitsWithin(getRateLimitBucket('anthropic', 'oauth'), 30)).toBe(false);
  });
});

describe('cross-process backoff via the usage ledger', () => {
  it('adopts a 429 freeze published by another process for the SAME key only', async () => {
    // "Process B": its own bucket + publishing gate on the shared ledger.
    const peerBucket = new RateLimitBucket();
    publishingGate(peerBucket, 'openai', 'api.openai.com').freeze(60_000);
    // Drop this process's connection so the read below opens a fresh handle.
    resetUsageLedgerForTests();
    // "Process A": registry buckets read the ledger.
    expect(await admitsWithin(getRateLimitBucket('openai', 'api.openai.com'), 50)).toBe(false);
    expect(await admitsWithin(getRateLimitBucket('openai', 'api.other.example'), 30)).toBe(true);
    expect(await admitsWithin(getRateLimitBucket('anthropic', 'oauth'), 30)).toBe(true);
  });

  it('adopts a freeze written through a separate StateStore connection', async () => {
    const now = Date.now();
    const other = new StateStore(getStateDatabasePath());
    other.put('usage', 'anthropic.oauth', {
      v: 1, provider: 'anthropic', account: 'oauth',
      perMinute: { frozenUntil: now + 30_000, observedAt: now },
    });
    other.close();
    expect(await admitsWithin(getRateLimitBucket('anthropic', 'oauth'), 50)).toBe(false);
  });

  it('falls back to local-only admission when the store cannot open', async () => {
    const notADir = join(dir, 'file');
    writeFileSync(notADir, 'x');
    process.env['AFK_HOME'] = notADir;
    resetUsageLedgerForTests();
    const bucket = getRateLimitBucket('anthropic', 'oauth');
    expect(await admitsWithin(bucket, 30)).toBe(true);
    bucket.update({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000 });
    expect(await admitsWithin(bucket, 30)).toBe(false);
  });
});

describe('RateLimitBucket peer adoption (injectable reader)', () => {
  it('throttles peer reads to once per interval', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const reader = vi.fn((): PeerRateLimitObservation | undefined => undefined);
    const bucket = new RateLimitBucket(reader);
    for (let i = 0; i < 5; i++) await bucket.acquirePermit(1);
    expect(reader).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_800_000_000_000 + PEER_SYNC_INTERVAL_MS - 1);
    await bucket.acquirePermit(1);
    expect(reader).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_800_000_000_000 + PEER_SYNC_INTERVAL_MS);
    await bucket.acquirePermit(1);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('a throwing reader is treated as no peer data', async () => {
    const bucket = new RateLimitBucket(() => { throw new Error('SQLITE_BUSY'); });
    expect(await admitsWithin(bucket, 30)).toBe(true);
  });

  it('ignores an expired peer freeze', async () => {
    const bucket = new RateLimitBucket(() => ({ frozenUntil: Date.now() - 1, observedAt: Date.now() - 5_000 }));
    expect(await admitsWithin(bucket, 30)).toBe(true);
  });

  it('clamps an absurd peer freeze to the bucket maximum', () => {
    const bucket = new RateLimitBucket();
    const now = Date.now();
    bucket.adoptPeer({ frozenUntil: now + 10 * 60_000, observedAt: now }, now);
    expect((bucket as unknown as { frozenUntil: number }).frozenUntil).toBe(now + 120_000);
  });

  it('adopts a lower remaining count from a fresher peer observation', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 10, requestsResetAt: Date.now() + 60_000 });
    const now = Date.now() + 1;
    bucket.adoptPeer({ requestsRemaining: 0, requestsResetAt: now + 60_000, observedAt: now }, now);
    expect(await admitsWithin(bucket, 30)).toBe(false);
  });

  it('ignores a peer count older than its own last server reading', async () => {
    const bucket = new RateLimitBucket();
    const stale = Date.now() - 1_000;
    bucket.update({ requestsRemaining: 10, requestsResetAt: Date.now() + 60_000 });
    bucket.adoptPeer({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000, observedAt: stale });
    expect(await admitsWithin(bucket, 30)).toBe(true);
  });

  it('ignores a higher peer count and a count whose window already reset', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 1, requestsResetAt: Date.now() + 60_000 });
    const now = Date.now() + 1;
    bucket.adoptPeer({ requestsRemaining: 500, observedAt: now }, now);
    bucket.adoptPeer({ requestsRemaining: 0, requestsResetAt: now - 1, observedAt: now }, now);
    expect(await admitsWithin(bucket, 30)).toBe(true); // consumes the one local slot
    expect(await admitsWithin(bucket, 30)).toBe(false);
  });
});
