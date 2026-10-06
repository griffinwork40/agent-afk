/**
 * Classifier for the ChatGPT/Codex subscription backend's usage-limit error.
 *
 * Contract: the ChatGPT backend (chatgpt.com/backend-api/codex) reports an
 * exhausted subscription window as an HTTP 429 whose JSON body is
 *
 *   {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached",
 *    "plan_type":"plus","resets_at":1777936568,"resets_in_seconds":13872}}
 *
 * with NO `retry-after` header (source: openai/codex `codex-rs/codex-api`
 * `api_bridge.rs` / `rate_limits.rs`; the official CLI never retries it).
 * The openai SDK surfaces that body on `APIError.error` and copies `type` onto
 * the error itself. A mid-stream SSE `error` payload arrives the same way but
 * with `status === undefined`, so this classifier keys ONLY on the body type
 * and never requires a status. No other OpenAI-compatible endpoint (local
 * shims, api.openai.com) sends this type, so they are never matched here.
 *
 * @module agent/providers/openai-compatible/query/chatgpt-usage-limit
 */

import { getHeader } from '../../shared/retry-after.js';

/** Body `type` the ChatGPT backend uses for an exhausted subscription window. */
export const CHATGPT_USAGE_LIMIT_TYPE = 'usage_limit_reached';

/** Parsed reset/plan details of a ChatGPT usage-limit error. All fields optional. */
export interface ChatGptUsageLimitInfo {
  /** Absolute reset time, from `resets_at` (preferred) or `resets_in_seconds`. */
  resetsAt?: Date;
  /** Subscription plan label (`plan_type`), e.g. `plus`, `pro`. */
  plan?: string;
  /** Length of the binding window in minutes, from the `x-codex-*` headers when present. */
  windowMinutes?: number;
}

/** Furthest-out reset we believe: a weekly window plus slack. */
const MAX_RESET_AHEAD_MS = 31 * 24 * 60 * 60 * 1000;
/** Tolerated clock skew for a `resets_at` that is already slightly in the past. */
const MAX_RESET_BEHIND_MS = 60 * 60 * 1000;

type BodyRecord = Record<string, unknown>;

function asRecord(v: unknown): BodyRecord | undefined {
  return v !== null && typeof v === 'object' ? (v as BodyRecord) : undefined;
}

/**
 * Find the record carrying `type === 'usage_limit_reached'`: the error itself
 * (SDK copies `type`), its `.error` body, or a nested `.error.error` body.
 * Returns the deepest matching body so `resets_at` / `plan_type` are readable,
 * falling back to the first match.
 */
function findMarkerBody(err: unknown): BodyRecord | undefined {
  const top = asRecord(err);
  if (top === undefined) return undefined;
  const body = asRecord(top['error']);
  const inner = body !== undefined ? asRecord(body['error']) : undefined;
  for (const candidate of [inner, body, top]) {
    if (candidate !== undefined && candidate['type'] === CHATGPT_USAGE_LIMIT_TYPE) return candidate;
  }
  return undefined;
}

function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** `resets_at` (epoch seconds) → Date, or undefined when outside the sane window. */
function resetFromEpoch(v: unknown, now: number): Date | undefined {
  const sec = toFiniteNumber(v);
  if (sec === undefined || sec <= 0) return undefined;
  const ms = sec * 1000;
  if (ms < now - MAX_RESET_BEHIND_MS || ms > now + MAX_RESET_AHEAD_MS) return undefined;
  return new Date(ms);
}

/** `resets_in_seconds` → Date, or undefined when negative or implausibly far. */
function resetFromDelta(v: unknown, now: number): Date | undefined {
  const sec = toFiniteNumber(v);
  if (sec === undefined || sec < 0) return undefined;
  const ms = sec * 1000;
  if (ms > MAX_RESET_AHEAD_MS) return undefined;
  return new Date(now + ms);
}

/** Plan labels are shown to users: keep them short and plain. */
function sanitizePlan(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const plan = v.trim();
  return /^[A-Za-z0-9 _.-]{1,32}$/.test(plan) ? plan : undefined;
}

/**
 * Best-effort window length from the `x-codex-primary-window-minutes` header.
 *
 * The header name is hardcoded — the server-controlled `x-codex-active-limit`
 * value is intentionally not used to construct it, because doing so would
 * allow a hostile server to select an arbitrary response header as the source
 * for this field.
 */
function windowMinutesFromHeaders(err: unknown): number | undefined {
  const raw = getHeader(err, 'x-codex-primary-window-minutes');
  const n = toFiniteNumber(raw);
  return n !== undefined && n > 0 ? n : undefined;
}

/**
 * Classify `err` as a ChatGPT `usage_limit_reached` error.
 *
 * @returns the parsed reset/plan details (every field optional) when the
 *   marker is present, or `null` for any other error, including a plain 429.
 */
export function classifyChatGptUsageLimit(
  err: unknown,
  now: number = Date.now(),
): ChatGptUsageLimitInfo | null {
  const body = findMarkerBody(err);
  if (body === undefined) return null;
  const resetsAt = resetFromEpoch(body['resets_at'], now) ?? resetFromDelta(body['resets_in_seconds'], now);
  const plan = sanitizePlan(body['plan_type']);
  const windowMinutes = windowMinutesFromHeaders(err);
  return {
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  };
}

/** True when `err` carries the ChatGPT `usage_limit_reached` marker. */
export function isChatGptUsageLimitError(err: unknown): boolean {
  return findMarkerBody(err) !== undefined;
}
