/**
 * Process-wide sliding-window token bucket for outbound Anthropic / OpenAI
 * API requests.
 *
 * Problem context: 429 errors account for ~35% of subagent failures in
 * high-fan-out sessions. The existing concurrency-pool gates dispatch slots,
 * NOT outbound HTTP — adding a global dispatch semaphore would deadlock (a
 * parent holds a slot while its child also needs one). The fix sites the gate
 * in the fetch layer, where no dispatch resource is held.
 *
 * Algorithm: proactive sliding-window bucket fed by response headers. The
 * bucket trusts the server's own "remaining" count on every response, so the
 * local estimate is corrected after every round-trip. Optimistic decrement
 * before the call, authoritative correction after.
 *
 * Deadlock-freedom: `acquirePermit` sleeps for TIME (until the rate-limit
 * window resets), not for another coroutine to release a semaphore. Multiple
 * coroutines can sleep simultaneously with no mutual exclusion.
 *
 * @module agent/providers/shared/rate-limit-bucket
 */

import { env } from '../../../config/env.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum wait when a 429 carries no Retry-After hint (ms). */
const RETRY_AFTER_MAX_WAIT_MS = 120_000;

/** Over-estimate overhead for system prompt + tool schemas (tokens). */
const INPUT_TOKEN_OVERHEAD = 2_000;

/** Characters per token estimate (conservative). */
const CHARS_PER_TOKEN = 3.5;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A partial update fed from response headers. Every field is optional so the
 * caller can omit what the provider does not report.
 */
export interface RateLimitSnapshot {
  requestsRemaining?: number;
  requestsLimit?: number;
  /** Epoch ms when the request window resets. */
  requestsResetAt?: number;
  inputTokensRemaining?: number;
  inputTokensLimit?: number;
  /** Epoch ms when the input-token window resets. */
  inputTokensResetAt?: number;
  outputTokensRemaining?: number;
  /** Epoch ms when the output-token window resets. */
  outputTokensResetAt?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function staggerJitterMs(): number {
  const raw = env.AFK_RATE_LIMIT_STAGGER_MAX_MS;
  const ceiling = raw !== undefined ? parseInt(raw, 10) : 500;
  const cap = Number.isFinite(ceiling) && ceiling >= 0 ? ceiling : 500;
  return Math.random() * cap;
}

function isAdmissionDisabled(): boolean {
  return env.AFK_RATE_LIMIT_ADMISSION_DISABLED === '1';
}

/**
 * Rough input-token estimate from request body bytes. Over-estimates
 * intentionally — the server corrects on the next response.
 */
export function estimateInputTokens(body: unknown): number {
  let chars = 0;
  if (typeof body === 'string') {
    chars = body.length;
  } else if (body && typeof body === 'object' && 'body' in body) {
    const b = (body as { body?: unknown }).body;
    if (typeof b === 'string') chars = b.length;
    else if (b instanceof ArrayBuffer) chars = b.byteLength;
    else if (b instanceof Uint8Array) chars = b.byteLength;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + INPUT_TOKEN_OVERHEAD;
}

// ── Core class ────────────────────────────────────────────────────────────────

/**
 * Process-wide token bucket. All state is -1 ("unknown") until the first
 * response carries the relevant headers. Unknown state = unlimited passthrough
 * (fail open, never block when we have no information).
 */
export class RateLimitBucket {
  // Request-per-minute window
  private requestsRemaining = -1;
  private requestsResetAt = 0;
  /** Most recent requestsLimit from a snapshot; used to replenish on window reset. */
  private requestsLimit = -1;

  // Input-token-per-minute window
  private inputTokensRemaining = -1;
  private inputTokensResetAt = 0;
  /** Most recent inputTokensLimit from a snapshot; used to replenish on window reset. */
  private inputTokensLimit = -1;

  // Output-token window (tracked but not gated — output size is unknown a priori,
  // so we cannot block a request on a number we cannot know before the call).
  private outputTokensRemainingVal = -1;

  // Hard freeze state: a 429 arrived; block ALL new requests until this time.
  private frozenUntil = 0;

  /** Reset all state; intended only for unit tests. */
  resetForTests(): void {
    this.requestsRemaining = -1;
    this.requestsResetAt = 0;
    this.requestsLimit = -1;
    this.inputTokensRemaining = -1;
    this.inputTokensResetAt = 0;
    this.inputTokensLimit = -1;
    this.outputTokensRemainingVal = -1;
    this.frozenUntil = 0;
  }

  /** Read-only snapshot of the tracked output-token headroom (informational; not gated). */
  get outputTokensRemaining(): number { return this.outputTokensRemainingVal; }

  /** Apply a snapshot from response headers, correcting the optimistic decrement. */
  update(snap: RateLimitSnapshot): void {
    if (snap.requestsRemaining !== undefined) this.requestsRemaining = snap.requestsRemaining;
    if (snap.requestsResetAt !== undefined) this.requestsResetAt = snap.requestsResetAt;
    if (snap.requestsLimit !== undefined) this.requestsLimit = snap.requestsLimit;
    if (snap.inputTokensRemaining !== undefined) this.inputTokensRemaining = snap.inputTokensRemaining;
    if (snap.inputTokensResetAt !== undefined) this.inputTokensResetAt = snap.inputTokensResetAt;
    if (snap.inputTokensLimit !== undefined) this.inputTokensLimit = snap.inputTokensLimit;
    if (snap.outputTokensRemaining !== undefined) this.outputTokensRemainingVal = snap.outputTokensRemaining;
    // outputTokensResetAt is not stored — output tokens are not gated (size unknown before call).
    // A freeze is only cleared by time expiration (frozenUntil > now check in acquirePermit),
    // not by a concurrent successful response that may have been in-flight before the 429.
  }

  /**
   * Freeze all new requests for `retryAfterMs` (clamped to
   * {@link RETRY_AFTER_MAX_WAIT_MS}). Called when a 429 arrives.
   */
  freeze(retryAfterMs: number): void {
    const clamped = Math.min(retryAfterMs, RETRY_AFTER_MAX_WAIT_MS);
    const candidate = Date.now() + clamped;
    // Only extend the freeze, never shorten it.
    if (candidate > this.frozenUntil) this.frozenUntil = candidate;
  }

  /** Advance windows whose deadline has already passed. */
  private maybeResetWindows(now: number): void {
    if (this.requestsResetAt > 0 && now >= this.requestsResetAt) {
      // Replenish to the last known limit rather than resetting to -1 (unknown).
      // Resetting to -1 would trigger the "unknown → unlimited passthrough" shortcut
      // in acquirePermit, releasing ALL sleeping waiters at once and recreating the
      // stampede the bucket is meant to prevent. Falls back to -1 if we never
      // received a limit header (preserves fail-open for the initial cold-start case).
      this.requestsRemaining = this.requestsLimit;
      this.requestsResetAt = 0;
    }
    if (this.inputTokensResetAt > 0 && now >= this.inputTokensResetAt) {
      this.inputTokensRemaining = this.inputTokensLimit;
      this.inputTokensResetAt = 0;
    }
  }

  /**
   * Wait until a permit is available for an outbound request, then decrement
   * the bucket optimistically.
   *
   * Resolves immediately when:
   *   - admission is disabled (`AFK_RATE_LIMIT_ADMISSION_DISABLED=1`),
   *   - the bucket is in unknown state on BOTH dimensions (no headers seen yet),
   *   - there is headroom in both the request AND the input-token windows.
   *
   * Sleeps with per-waiter jitter when capacity is exhausted, so concurrent
   * waiters at a window boundary spread across 0–500ms (configurable via
   * `AFK_RATE_LIMIT_STAGGER_MAX_MS`) rather than storming simultaneously.
   *
   * If `signal` is provided and fires while waiting, the permit resolves
   * immediately (abort unblocks all waiters so a Ctrl-C never hangs).
   */
  async acquirePermit(estimatedInputTokens: number, signal?: AbortSignal): Promise<void> {
    if (isAdmissionDisabled()) return;

    for (;;) {
      if (signal?.aborted) return;

      const now = Date.now();

      // Hard freeze from a 429 — wait out the retry-after.
      if (this.frozenUntil > now) {
        const waitMs = this.frozenUntil - now;
        await Promise.race([
          sleep(waitMs),
          signal ? new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })) : Promise.resolve(),
        ]);
        continue;
      }

      // Advance windows that have already expired.
      this.maybeResetWindows(now);

      // Unknown state on BOTH dimensions → unlimited passthrough.
      if (this.requestsRemaining === -1 && this.inputTokensRemaining === -1) return;

      // Check headroom: request slot AND (if known) input-token headroom.
      const tokenOk =
        this.inputTokensRemaining === -1 ||
        this.inputTokensRemaining >= estimatedInputTokens;

      if (this.requestsRemaining >= 1 && tokenOk) {
        // Optimistically decrement; the server corrects us on the next response.
        this.requestsRemaining -= 1;
        if (this.inputTokensRemaining > 0 && this.inputTokensRemaining !== -1) {
          this.inputTokensRemaining = Math.max(0, this.inputTokensRemaining - estimatedInputTokens);
        }
        return;
      }

      // Not enough headroom — sleep until the next window resets.
      // Use a hard cap so a malformed reset header cannot park us forever.
      const candidates: number[] = [];
      if (this.requestsResetAt > now) candidates.push(this.requestsResetAt);
      if (this.inputTokensResetAt > now) candidates.push(this.inputTokensResetAt);
      const nextReset = candidates.length > 0 ? Math.min(...candidates) : now + 60_000;
      const sleepMs = Math.max(1, nextReset - now) + staggerJitterMs();

      await Promise.race([
        sleep(sleepMs),
        signal ? new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })) : Promise.resolve(),
      ]);
    }
  }
}

/**
 * Process-wide singleton. Imported by the fetch wrappers and client-setup
 * modules; never shared with concurrency-pool or the dispatch layer.
 */
export const globalRateLimitBucket = new RateLimitBucket();
