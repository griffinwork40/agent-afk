/**
 * The single usage reader. Every consumer — `afk usage`, `get_runtime_state`,
 * the fan-out notice, the daemon budget gate — reads usage through this
 * module and nowhere else.
 *
 * Sources, merged with the monotone rules of `usage-record.ts` (newest
 * observation wins per section, freezes merge by MAX):
 *   1. The cross-process ledger (`usage-ledger.ts`) — what any AFK process on
 *      this machine has observed.
 *   2. This process's quota cache (`quota-cache.ts`) — so usage stays visible
 *      when the ledger is disabled or its store failed to open.
 *   3. Optionally, a fresh read of the Claude OAuth usage endpoint
 *      ({@link collectUsage}); the result is also published to the ledger.
 *
 * @module agent/usage/usage-snapshot
 */

import { getQuotaSnapshot } from '../quota-cache.js';
import {
  fetchSubscriptionUsage,
  type FetchSubscriptionUsageOptions,
  type UsageResult,
} from '../subscription-usage.js';
import { mergeUsageRecords, usageKey, type UsageRecord } from './usage-record.js';
import {
  publishUsage,
  readLedgerRecords,
  windowsFromQuotaSnapshot,
  windowsFromUsageResult,
} from './usage-ledger.js';

/** Provider/account of the Claude subscription (unified 5h/7d windows). */
export const ANTHROPIC_OAUTH = { provider: 'anthropic', account: 'oauth' } as const;

/**
 * All known usage records (ledger + in-process cache + `extra`), one per
 * provider/account, sorted by key. Synchronous, no network. Never throws.
 */
export function readUsageRecords(extra: readonly UsageRecord[] = []): UsageRecord[] {
  const byKey = new Map<string, UsageRecord>();
  const add = (r: UsageRecord): void => {
    const k = usageKey(r.provider, r.account);
    byKey.set(k, mergeUsageRecords(byKey.get(k), r));
  };
  for (const r of readLedgerRecords()) add(r);
  const local = getQuotaSnapshot();
  if (local !== undefined) {
    add({ v: 1, ...ANTHROPIC_OAUTH, windows: windowsFromQuotaSnapshot(local) });
  }
  for (const r of extra) add(r);
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
}

/** The record for one provider/account, or undefined when nothing is known. */
export function readUsageRecord(provider: string, account: string): UsageRecord | undefined {
  return readUsageRecords().find((r) => r.provider === provider && r.account === account);
}

export interface CollectUsageOptions {
  /** Injectable for tests. Defaults to the real OAuth usage endpoint fetch. */
  readonly fetchUsage?: (opts?: FetchSubscriptionUsageOptions) => Promise<UsageResult>;
  readonly now?: number;
}

export interface CollectedUsage {
  readonly records: UsageRecord[];
  /** Raw endpoint outcome, so callers can surface why a refresh failed. */
  readonly anthropic: UsageResult;
}

/**
 * Refresh the Claude subscription windows from the OAuth usage endpoint
 * (publishing them to the ledger), then read everything. Never throws: an
 * endpoint failure leaves the ledger/cache records as the answer.
 */
export async function collectUsage(opts: CollectUsageOptions = {}): Promise<CollectedUsage> {
  const now = opts.now ?? Date.now();
  const doFetch = opts.fetchUsage ?? fetchSubscriptionUsage;
  let anthropic: UsageResult;
  try {
    anthropic = await doFetch();
  } catch {
    anthropic = { kind: 'unavailable', reason: 'network-error', detail: 'usage fetch threw' };
  }
  const windows = windowsFromUsageResult(anthropic, now);
  const extra: UsageRecord[] = [];
  if (windows !== undefined) {
    const rec: UsageRecord = { v: 1, ...ANTHROPIC_OAUTH, windows };
    publishUsage(rec, now);
    extra.push(rec);
  }
  return { records: readUsageRecords(extra), anthropic };
}
