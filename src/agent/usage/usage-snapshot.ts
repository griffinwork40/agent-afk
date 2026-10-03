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
 *   3. Optionally, fresh reads of the Claude OAuth and ChatGPT (Codex)
 *      usage endpoints ({@link collectUsage}); results are also published to
 *      the ledger.
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
import { CODEX_SUBSCRIPTION, fetchCodexUsage } from './codex-usage.js';
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
  /** Also refresh the ChatGPT (Codex) subscription windows. Default true. */
  readonly includeCodex?: boolean;
  /** Injectable for tests. Defaults to the ChatGPT `wham/usage` fetch. */
  readonly fetchCodex?: () => Promise<UsageResult>;
  readonly now?: number;
}

export interface CollectedUsage {
  readonly records: UsageRecord[];
  /** Raw endpoint outcomes, so callers can surface why a refresh failed. */
  readonly anthropic: UsageResult;
  /** Absent when `includeCodex` was false. */
  readonly codex?: UsageResult;
}

/** Run one endpoint fetch; on success publish it to the ledger and return the record. */
async function refresh(
  ids: { readonly provider: string; readonly account: string },
  doFetch: () => Promise<UsageResult>,
  now: number,
): Promise<{ result: UsageResult; record?: UsageRecord }> {
  let result: UsageResult;
  try {
    result = await doFetch();
  } catch {
    result = { kind: 'unavailable', reason: 'network-error', detail: 'usage fetch threw' };
  }
  const windows = windowsFromUsageResult(result, now);
  if (windows === undefined) return { result };
  const record: UsageRecord = { v: 1, ...ids, windows };
  publishUsage(record, now);
  return { result, record };
}

/**
 * Refresh the subscription windows from their usage endpoints (Claude OAuth,
 * and ChatGPT/Codex unless `includeCodex` is false), publishing each to the
 * ledger, then read everything. Fetches run in parallel. Never throws: an
 * endpoint failure leaves the ledger/cache records as the answer.
 */
export async function collectUsage(opts: CollectUsageOptions = {}): Promise<CollectedUsage> {
  const now = opts.now ?? Date.now();
  const fetchClaude = opts.fetchUsage ?? fetchSubscriptionUsage;
  const fetchCodex = opts.fetchCodex ?? fetchCodexUsage;
  const [anthropic, codex] = await Promise.all([
    refresh(ANTHROPIC_OAUTH, () => fetchClaude(), now),
    opts.includeCodex === false ? undefined : refresh(CODEX_SUBSCRIPTION, () => fetchCodex(), now),
  ]);
  const extra = [anthropic.record, codex?.record].filter((r): r is UsageRecord => r !== undefined);
  return {
    records: readUsageRecords(extra),
    anthropic: anthropic.result,
    ...(codex !== undefined ? { codex: codex.result } : {}),
  };
}
