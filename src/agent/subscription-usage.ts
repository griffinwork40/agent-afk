/**
 * Fetch subscription usage windows (5-hour / 7-day / 7-day-Sonnet / 7-day-Opus)
 * from the Claude Code OAuth usage endpoint, and render them as plain text.
 *
 * The endpoint and its response shape are reverse-engineered and unversioned;
 * upstream may change them at any time without notice. Parsing below is
 * therefore fully defensive — unknown or missing fields are treated as absent
 * windows rather than thrown errors — and `fetchSubscriptionUsage` never
 * rejects or throws: every path (missing token, network failure, timeout,
 * non-2xx, malformed body) resolves to a `UsageResult` the caller can render
 * or branch on.
 *
 * @module agent/subscription-usage
 */

import { loadClaudeCodeOauthToken } from './auth/keychain.js';
import { env } from '../config/env.js';
import { DEFAULT_USAGE_TIMEOUT_MS, fetchUsageJson } from './usage/usage-http.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/** One usage window (e.g. the rolling 5-hour or 7-day allowance). */
export interface UsageWindow {
  /** Fraction of the window consumed, 0..1. */
  readonly utilization: number;
  /** When the window resets, when the API supplies it. */
  readonly resetsAt?: Date;
}

/** A successfully retrieved and parsed usage snapshot. */
export interface UsageSnapshot {
  readonly kind: 'ok';
  readonly fiveHour?: UsageWindow;
  readonly sevenDay?: UsageWindow;
  readonly sevenDaySonnet?: UsageWindow;
  readonly sevenDayOpus?: UsageWindow;
}

/** Why a usage snapshot could not be retrieved. */
export type UsageUnavailableReason =
  | 'no-token'
  | 'http-error'
  | 'malformed-response'
  | 'timeout'
  | 'network-error';

/** Usage could not be retrieved. */
export interface UsageUnavailable {
  readonly kind: 'unavailable';
  readonly reason: UsageUnavailableReason;
  /** Short human-readable detail, safe to show a user. Never contains the token. */
  readonly detail: string;
}

export type UsageResult = UsageSnapshot | UsageUnavailable;

export interface FetchSubscriptionUsageOptions {
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Override the OAuth token. Defaults to the keychain loader. */
  readonly token?: string;
  /** Request timeout. Defaults to 10_000. */
  readonly timeoutMs?: number;
}

/**
 * Fetch the current subscription usage snapshot from the Claude Code OAuth
 * usage endpoint.
 *
 * Never throws: every failure mode (missing token, network error, timeout,
 * non-2xx status, unparseable or unrecognized body) resolves to
 * `{ kind: 'unavailable', ... }` rather than rejecting the returned promise.
 */
export async function fetchSubscriptionUsage(
  options?: FetchSubscriptionUsageOptions,
): Promise<UsageResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
  const token = options?.token ?? (env.CLAUDE_CODE_OAUTH_TOKEN || loadClaudeCodeOauthToken());

  if (!token) {
    return {
      kind: 'unavailable',
      reason: 'no-token',
      detail:
        'No Claude Code OAuth token found. Set CLAUDE_CODE_OAUTH_TOKEN or run `claude login` and try again.',
    };
  }

  const res = await fetchUsageJson(
    USAGE_URL,
    { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA_HEADER },
    { fetchImpl, timeoutMs },
  );
  if (res.kind !== 'json') return res;
  const record = res.body;
  const fiveHour = parseWindow(record['five_hour']);
  const sevenDay = parseWindow(record['seven_day']);
  const sevenDaySonnet = parseWindow(record['seven_day_sonnet']);
  const sevenDayOpus = parseWindow(record['seven_day_opus']);

  if (!fiveHour && !sevenDay && !sevenDaySonnet && !sevenDayOpus) {
    return {
      kind: 'unavailable',
      reason: 'malformed-response',
      detail: 'Usage endpoint response contained none of the known usage windows.',
    };
  }

  return {
    kind: 'ok',
    ...(fiveHour !== undefined ? { fiveHour } : {}),
    ...(sevenDay !== undefined ? { sevenDay } : {}),
    ...(sevenDaySonnet !== undefined ? { sevenDaySonnet } : {}),
    ...(sevenDayOpus !== undefined ? { sevenDayOpus } : {}),
  };
}

/** Reject epoch-seconds values outside a sane [1970, 2100) range. */
const MIN_REASONABLE_EPOCH_SECONDS = 0;
const MAX_REASONABLE_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

function parseResetsAt(value: unknown): Date | undefined {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      value < MIN_REASONABLE_EPOCH_SECONDS ||
      value > MAX_REASONABLE_EPOCH_SECONDS
    ) {
      return undefined;
    }
    return new Date(value * 1000);
  }
  return undefined;
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const utilizationRaw = record['utilization'];
  if (typeof utilizationRaw !== 'number' || !Number.isFinite(utilizationRaw)) return undefined;
  // Contract: the endpoint reports utilization as a 0..100 PERCENTAGE
  // (verified live 2026-10-03: five_hour 27, seven_day 5). Always divide by
  // 100. History: the parser used to guess the unit (values <=1 read as a
  // 0..1 fraction), so a real 1% came back as 100% (a phantom full window
  // that the daemon budget gate would act on). Result clamped to [0, 1].
  const normalized = utilizationRaw / 100;
  const utilization = Math.min(1, Math.max(0, normalized));
  const resetsAt = parseResetsAt(record['resets_at']);
  return {
    utilization,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * Surface-neutral plain text. No chalk, no HTML, no markdown.
 * Test-only: no production importers (usage-formatter.ts handles all surfaces).
 * @internal
 */
export function formatUsagePlain(result: UsageResult): string {
  if (result.kind === 'unavailable') {
    return `Usage unavailable (${result.reason}): ${result.detail}`;
  }
  const lines: string[] = [];
  if (result.fiveHour) lines.push(formatWindowLine('5h', result.fiveHour));
  if (result.sevenDay) lines.push(formatWindowLine('7d', result.sevenDay));
  if (result.sevenDaySonnet) lines.push(formatWindowLine('7d-sonnet', result.sevenDaySonnet));
  if (result.sevenDayOpus) lines.push(formatWindowLine('7d-opus', result.sevenDayOpus));
  return lines.length > 0 ? lines.join('\n') : 'No usage windows available.';
}

function formatWindowLine(label: string, win: UsageWindow): string {
  const pct = Math.round(win.utilization * 100);
  if (!win.resetsAt) return `${label}: ${pct}%`;
  const hh = String(win.resetsAt.getUTCHours()).padStart(2, '0');
  const mm = String(win.resetsAt.getUTCMinutes()).padStart(2, '0');
  return `${label}: ${pct}% (resets ${hh}:${mm})`;
}
