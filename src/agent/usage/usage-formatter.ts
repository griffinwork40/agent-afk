/**
 * The single usage formatter. Turns {@link UsageRecord}s (from
 * `usage-snapshot.ts`) into:
 *   - a structured {@link UsageSummary} — the `afk usage --json` shape;
 *   - plain text lines ({@link formatUsageSummaryText});
 *   - compact per-provider entries for `get_runtime_state`
 *     ({@link compactUsageEntries});
 *   - one-line sentences for the fan-out notice and the daemon skip notice
 *     ({@link describeBindingWindow}).
 *
 * Pure module: no I/O, no module state, no colour (the CLI layers colour on top).
 *
 * @module agent/usage/usage-formatter
 */

import { formatResetCountdown } from '../../cli/quota-indicator.js';
import { WINDOW_KEYS, WINDOW_LABELS, type UsageRecord, type WindowKey } from './usage-record.js';
import { isStale, levelFor, type BindingWindow } from './usage-budget.js';

// ─── Output types ────────────────────────────────────────────────────────────

/** One utilization window, in structured form. */
export interface UsageWindowSummary {
  /** Fraction consumed, 0..1. */
  readonly utilization: number;
  /** Integer percent for display, 0..100. */
  readonly utilizationPct: number;
  /** Epoch ms of the reset, when known. */
  readonly resetsAtMs?: number;
  /** Human-readable countdown to reset, e.g. "2h10m". */
  readonly resetsIn?: string;
}

/** Per-minute admission numbers (from response headers). */
export interface PerMinuteSummary {
  readonly requestsRemaining?: number;
  readonly requestsLimit?: number;
  readonly tokensRemaining?: number;
  readonly tokensLimit?: number;
  /** Epoch ms until which new requests are frozen due to a 429. */
  readonly frozenUntilMs?: number;
  /** Human-readable time left in the freeze, e.g. "2m". */
  readonly frozenFor?: string;
}

/**
 * Summary for one provider/account.
 *   - `'ok'`      — data available and fresh.
 *   - `'stale'`   — data older than the shared staleness cutoff.
 *   - `'unknown'` — no signal (Codex subscription, xAI, pre-first-call).
 *   - `'error'`   — a fetch was attempted and failed, and nothing else is known.
 */
export interface ProviderUsageSummary {
  readonly provider: string;
  readonly account: string;
  readonly status: 'ok' | 'stale' | 'unknown' | 'error';
  readonly errorDetail?: string;
  /** Age of the most recent observation in ms, when available. */
  readonly ageMs?: number;
  readonly perMinute?: PerMinuteSummary;
  readonly fiveHour?: UsageWindowSummary;
  readonly sevenDay?: UsageWindowSummary;
  readonly sevenDaySonnet?: UsageWindowSummary;
  readonly sevenDayOpus?: UsageWindowSummary;
}

/** Top-level structured output (`afk usage --json`). */
export interface UsageSummary {
  /** Epoch ms at which the summary was built. */
  readonly asOfMs: number;
  readonly providers: readonly ProviderUsageSummary[];
}

/** Compact entry for `get_runtime_state` (`usage` field). */
export interface CompactUsageEntry {
  provider: string;
  account: string;
  status: ProviderUsageSummary['status'];
  /** 5h rolling window utilization 0..100, when available. */
  fiveHourPct?: number;
  /** 7d rolling window utilization 0..100, when available. */
  sevenDayPct?: number;
  /** Epoch ms until which new requests are frozen (only while in force). */
  frozenUntilMs?: number;
}

// ─── Builders ────────────────────────────────────────────────────────────────

function windowSummary(utilization: number, resetsAt: number | undefined, now: number): UsageWindowSummary {
  const msLeft = resetsAt !== undefined ? resetsAt - now : 0;
  return {
    utilization,
    utilizationPct: Math.round(utilization * 100),
    ...(resetsAt !== undefined ? { resetsAtMs: resetsAt } : {}),
    ...(msLeft > 0 ? { resetsIn: formatResetCountdown(msLeft) } : {}),
  };
}

function perMinuteSummary(rec: UsageRecord, now: number): PerMinuteSummary | undefined {
  const pm = rec.perMinute;
  if (pm === undefined) return undefined;
  const frozen = pm.frozenUntil !== undefined && pm.frozenUntil > now ? pm.frozenUntil : undefined;
  const out: PerMinuteSummary = {
    ...(pm.requestsRemaining !== undefined ? { requestsRemaining: pm.requestsRemaining } : {}),
    ...(pm.requestsLimit !== undefined ? { requestsLimit: pm.requestsLimit } : {}),
    ...(pm.tokensRemaining !== undefined ? { tokensRemaining: pm.tokensRemaining } : {}),
    ...(pm.tokensLimit !== undefined ? { tokensLimit: pm.tokensLimit } : {}),
    ...(frozen !== undefined ? { frozenUntilMs: frozen, frozenFor: formatResetCountdown(frozen - now) } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function latestObservedAt(rec: UsageRecord): number | undefined {
  const a = rec.windows?.observedAt;
  const b = rec.perMinute?.observedAt;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/** Summarize one ledger/cache record. */
export function summarizeUsageRecord(rec: UsageRecord, now: number = Date.now()): ProviderUsageSummary {
  const observedAt = latestObservedAt(rec);
  if (observedAt === undefined) return unknownProviderSummary(rec.provider, rec.account);
  const windows: Partial<Record<WindowKey, UsageWindowSummary>> = {};
  for (const k of WINDOW_KEYS) {
    const w = rec.windows?.[k];
    if (w !== undefined) windows[k] = windowSummary(w.utilization, w.resetsAt, now);
  }
  const perMinute = perMinuteSummary(rec, now);
  return {
    provider: rec.provider,
    account: rec.account,
    status: isStale(observedAt, now) ? 'stale' : 'ok',
    ageMs: Math.max(0, now - observedAt),
    ...(perMinute !== undefined ? { perMinute } : {}),
    ...windows,
  };
}

/** Sentinel for providers with no usage signal (Codex subscription, xAI). */
export function unknownProviderSummary(provider: string, account: string): ProviderUsageSummary {
  return { provider, account, status: 'unknown' };
}

/** Sentinel for a provider whose usage fetch failed and of which nothing else is known. */
export function errorProviderSummary(provider: string, account: string, detail: string): ProviderUsageSummary {
  return { provider, account, status: 'error', errorDetail: detail };
}

/** Compact `get_runtime_state` entries — one per record, no network. */
export function compactUsageEntries(records: readonly UsageRecord[], now: number = Date.now()): CompactUsageEntry[] {
  return records.map((rec) => {
    const s = summarizeUsageRecord(rec, now);
    return {
      provider: s.provider,
      account: s.account,
      status: s.status,
      ...(s.fiveHour !== undefined ? { fiveHourPct: s.fiveHour.utilizationPct } : {}),
      ...(s.sevenDay !== undefined ? { sevenDayPct: s.sevenDay.utilizationPct } : {}),
      ...(s.perMinute?.frozenUntilMs !== undefined ? { frozenUntilMs: s.perMinute.frozenUntilMs } : {}),
    };
  });
}

/** Display name for a provider id in one-line notices. */
const PROVIDER_DISPLAY: Readonly<Record<string, string>> = { anthropic: 'Claude', codex: 'Codex' };
function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY[provider] ?? provider;
}

/**
 * One-line description of the binding window, shared by the fan-out notice
 * and the daemon skip notice: `Claude 5h window at 86%, resets in 2h10m`.
 */
export function describeBindingWindow(provider: string, binding: BindingWindow, now: number = Date.now()): string {
  const msLeft = binding.resetsAt !== undefined ? binding.resetsAt - now : 0;
  const reset = msLeft > 0 ? `, resets in ${formatResetCountdown(msLeft)}` : '';
  return `${providerDisplayName(provider)} ${binding.label} window at ${binding.pct}%${reset}`;
}

// ─── Text formatter ──────────────────────────────────────────────────────────

/** One label/value row per present datum — the CLI panel and text output share it. */
export interface UsageRow {
  readonly label: string;
  readonly value: string;
  /** Severity from the shared evaluator (`usage-budget.ts`) — drives CLI colour. */
  readonly level?: 'ok' | 'warn' | 'over' | 'info';
}

function windowRow(key: WindowKey, w: UsageWindowSummary): UsageRow {
  const reset = w.resetsIn !== undefined ? ` (resets in ${w.resetsIn})` : '';
  return { label: `${WINDOW_LABELS[key]} utilization`, value: `${w.utilizationPct}%${reset}`, level: levelFor(w.utilization) };
}

/** Rows describing one provider (excluding its header). */
export function usageRows(p: ProviderUsageSummary): UsageRow[] {
  if (p.status === 'unknown') return [{ label: 'Usage', value: 'No usage data (provider has no signal)', level: 'info' }];
  if (p.status === 'error') return [{ label: 'Usage', value: p.errorDetail ?? 'Unknown error', level: 'over' }];
  const rows: UsageRow[] = [];
  const pm = p.perMinute;
  if (pm?.frozenFor !== undefined) rows.push({ label: 'Frozen (429)', value: `${pm.frozenFor} remaining`, level: 'over' });
  if (pm?.requestsRemaining !== undefined) {
    rows.push({ label: 'Requests/min remaining', value: `${pm.requestsRemaining}${pm.requestsLimit !== undefined ? `/${pm.requestsLimit}` : ''}`, level: 'info' });
  }
  if (pm?.tokensRemaining !== undefined) {
    rows.push({ label: 'Tokens/min remaining', value: `${pm.tokensRemaining}${pm.tokensLimit !== undefined ? `/${pm.tokensLimit}` : ''}`, level: 'info' });
  }
  for (const k of WINDOW_KEYS) {
    const w = p[k];
    if (w !== undefined) rows.push(windowRow(k, w));
  }
  if (rows.length === 0) rows.push({ label: 'Usage', value: 'No utilization data available', level: 'info' });
  if (p.ageMs !== undefined && p.ageMs > 0) rows.push({ label: 'Data age', value: formatResetCountdown(p.ageMs), level: 'info' });
  return rows;
}

function statusTag(p: ProviderUsageSummary): string {
  if (p.status === 'ok') return '';
  if (p.status === 'error') return ' [error]';
  return ` [${p.status}]`;
}

/** Render a usage summary as plain text lines (no colour). */
export function formatUsageSummaryText(summary: UsageSummary): string[] {
  const lines: string[] = [];
  for (const p of summary.providers) {
    lines.push(`${p.provider} / ${p.account}${statusTag(p)}`);
    for (const r of usageRows(p)) lines.push(`  ${r.label}: ${r.value}`);
  }
  return lines;
}
