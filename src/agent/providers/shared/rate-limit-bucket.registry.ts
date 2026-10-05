/**
 * Per-provider+account admission buckets.
 *
 * Each distinct rate-limit domain (Anthropic per auth mode, OpenAI-compatible
 * per endpoint host) gets its own {@link RateLimitBucket}, so one provider's
 * response headers never overwrite another's remaining counts or freeze.
 *
 * Each bucket is wired to the cross-process usage ledger for the SAME
 * provider+account (`usage-ledger.ts` `readLedgerRecord`), so a 429 freeze or
 * a lower remaining count observed by another AFK process on this machine is
 * adopted locally (see the bucket's "Cross-process backoff" header). The read
 * is throttled inside the bucket and fails open.
 *
 * @module agent/providers/shared/rate-limit-bucket.registry
 */

import { RateLimitBucket } from './rate-limit-bucket.js';
import { readLedgerRecord } from '../../usage/usage-ledger.js';
import { usageKey } from '../../usage/usage-record.js';

// Invariant: one bucket per ledger key for the life of the process. Every
// client built for the same provider+account (including OAuth-refresh rebuilds)
// must share admission state, exactly as the old process-wide singleton did.
const buckets = new Map<string, RateLimitBucket>();

/**
 * The admission bucket for one provider+account, created on first use with a
 * peer reader over the shared usage ledger. `account` uses the same identity
 * the provider publishes to the ledger under (auth mode / endpoint host).
 */
export function getRateLimitBucket(provider: string, account: string): RateLimitBucket {
  const key = usageKey(provider, account);
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = new RateLimitBucket(() => readLedgerRecord(provider, account)?.perMinute);
    buckets.set(key, bucket);
  }
  return bucket;
}

/** Test-only: drop every keyed bucket. */
export function resetRateLimitBucketsForTests(): void {
  buckets.clear();
}
