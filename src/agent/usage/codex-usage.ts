/**
 * Codex (ChatGPT subscription) usage windows from the ChatGPT usage endpoint.
 *
 * `GET https://chatgpt.com/backend-api/wham/usage` with the ChatGPT sign-in
 * from `~/.codex/auth.json` (resolved by the provider's own
 * `resolveOpenAIAuth(..., forceChatgptOAuth=true)`, read-only: AFK never
 * refreshes it) and the same request headers AFK already sends to the ChatGPT
 * backend (`buildChatGptOAuthHeaders`). This is the route the open-source
 * Codex client uses for its own plan limits; it is NOT a documented public API
 * and can change without notice (the same standing risk as Anthropic's
 * `anthropic-ratelimit-unified-*` headers).
 *
 * The result is the shared {@link UsageResult} shape, so the ledger adapter
 * (`windowsFromUsageResult`), the reader, the evaluator, and the formatter all
 * apply to Codex unchanged.
 *
 * Contract: windows are classified by their reported length
 * (`limit_window_seconds`), never by position. `primary` is the 5h window on
 * some plans and the weekly window on others. A window that is neither ~5h nor
 * ~7d is dropped rather than mislabeled.
 *
 * @module agent/usage/codex-usage
 */

import type { UsageResult, UsageSnapshot, UsageWindow } from '../subscription-usage.js';
import { resolveOpenAIAuth, type OpenAIAuthResolution } from '../providers/openai-compatible/auth.js';
import { buildChatGptOAuthHeaders } from '../providers/openai-compatible/responses-config.js';
import { fetchUsageJson, type UsageHttpOptions } from './usage-http.js';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** Ledger provider/account for the ChatGPT (Codex) subscription. */
export const CODEX_SUBSCRIPTION = { provider: 'codex', account: 'chatgpt-subscription' } as const;

const HOUR_S = 3_600;
const DAY_S = 86_400;
const MAX_REASONABLE_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

export interface FetchCodexUsageOptions extends UsageHttpOptions {
  /** Injectable for tests. Defaults to the forced ChatGPT-subscription resolution. */
  readonly auth?: () => Pick<OpenAIAuthResolution, 'apiKey' | 'source' | 'accountId'>;
}

/** Fetch the ChatGPT subscription windows. Never throws. */
export async function fetchCodexUsage(options: FetchCodexUsageOptions = {}): Promise<UsageResult> {
  let auth: Pick<OpenAIAuthResolution, 'apiKey' | 'source' | 'accountId'>;
  try {
    auth = (options.auth ?? (() => resolveOpenAIAuth(undefined, {}, true)))();
  } catch {
    return { kind: 'unavailable', reason: 'no-token', detail: 'Could not read the ChatGPT sign-in.' };
  }
  if (!auth.apiKey) {
    return {
      kind: 'unavailable',
      reason: 'no-token',
      detail:
        auth.source === 'chatgpt-oauth-expired'
          ? 'ChatGPT sign-in expired. Run `codex` to refresh it.'
          : 'No ChatGPT sign-in found (~/.codex/auth.json). Run `codex login`.',
    };
  }
  const res = await fetchUsageJson(
    CODEX_USAGE_URL,
    { Authorization: `Bearer ${auth.apiKey}`, Accept: 'application/json', ...buildChatGptOAuthHeaders(auth.accountId) },
    options,
  );
  return res.kind === 'json' ? parseCodexUsagePayload(res.body) : res;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

type WindowSlot = 'fiveHour' | 'sevenDay';

function slotFor(seconds: number): WindowSlot | undefined {
  if (seconds >= 4 * HOUR_S && seconds <= 6 * HOUR_S) return 'fiveHour';
  if (seconds >= 6 * DAY_S && seconds <= 8 * DAY_S) return 'sevenDay';
  return undefined;
}

function parseCodexWindow(raw: unknown): { slot: WindowSlot; window: UsageWindow } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const w = raw as Record<string, unknown>;
  const used = num(w['used_percent']);
  const length = num(w['limit_window_seconds']);
  if (used === undefined || length === undefined) return undefined;
  const slot = slotFor(length);
  if (slot === undefined) return undefined;
  const resetAt = num(w['reset_at']);
  const utilization = Math.min(1, Math.max(0, used / 100));
  const resetsAt =
    resetAt !== undefined && resetAt > 0 && resetAt <= MAX_REASONABLE_EPOCH_SECONDS ? new Date(resetAt * 1000) : undefined;
  return { slot, window: { utilization, ...(resetsAt ? { resetsAt } : {}) } };
}

/** Map a `wham/usage` body to the shared usage shape. Pure. */
export function parseCodexUsagePayload(body: Record<string, unknown>): UsageResult {
  const rl = body['rate_limit'];
  const limits = typeof rl === 'object' && rl !== null ? (rl as Record<string, unknown>) : {};
  const out: { fiveHour?: UsageWindow; sevenDay?: UsageWindow } = {};
  for (const key of ['primary_window', 'secondary_window']) {
    const parsed = parseCodexWindow(limits[key]);
    if (parsed !== undefined && out[parsed.slot] === undefined) out[parsed.slot] = parsed.window;
  }
  if (out.fiveHour === undefined && out.sevenDay === undefined) {
    return {
      kind: 'unavailable',
      reason: 'malformed-response',
      detail: 'Codex usage response contained no 5h or 7d window.',
    };
  }
  const snapshot: UsageSnapshot = { kind: 'ok', ...out };
  return snapshot;
}
