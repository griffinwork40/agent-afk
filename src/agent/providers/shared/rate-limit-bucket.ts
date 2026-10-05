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
 * Cross-process backoff: a bucket constructed with a {@link PeerRateLimitReader}
 * (see `rate-limit-bucket.registry.ts`, which wires the shared usage ledger)
 * adopts what OTHER processes on the same provider+account have observed: an
 * in-force 429 freeze, and a lower remaining count from a reading fresher than
 * this bucket's own last server response. The peer read is throttled to once
 * per {@link PEER_SYNC_INTERVAL_MS} and fails open (reader error = local-only
 * behaviour). Adoption only ever makes the bucket MORE conservative, and it
 * still sleeps for time, so deadlock-freedom is unchanged.
 *
 * @module agent/providers/shared/rate-limit-bucket
 */

import { env } from '../../../config/env.js';
import { sleepWithAbort } from './sleep-with-abort.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum wait when a 429 carries no Retry-After hint (ms). */
const RETRY_AFTER_MAX_WAIT_MS = 120_000;

/** Over-estimate overhead for system prompt + tool schemas (tokens). */
const INPUT_TOKEN_OVERHEAD = 2_000;

/** Characters per token estimate (conservative). */
const CHARS_PER_TOKEN = 3.5;

/** Minimum spacing between peer (ledger) reads for one bucket (ms). */
export const PEER_SYNC_INTERVAL_MS = 1_000;

/** A peer count with no reset timestamp is trusted only this long after it was read (ms). */
const PEER_UNTIMED_MAX_AGE_MS = 60_000;

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

/**
 * What another process observed for the same provider+account. Field names
 * match the usage ledger's `PerMinuteObservation` so a ledger record's
 * `perMinute` section is assignable as-is. All times are epoch ms.
 */
export interface PeerRateLimitObservation {
  requestsRemaining?: number;
  requestsLimit?: number;
  requestsResetAt?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  tokensResetAt?: number;
  frozenUntil?: number;
  observedAt: number;
}

/** Synchronous peer source. May throw; the bucket treats a throw as "no peer data". */
export type PeerRateLimitReader = () => PeerRateLimitObservation | undefined;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when a peer's remaining count is current and lower than the local one. */
function peerCountApplies(
  peerRemaining: number | undefined,
  peerResetAt: number | undefined,
  observedAt: number,
  now: number,
  localRemaining: number,
): peerRemaining is number {
  if (peerRemaining === undefined) return false;
  const current = peerResetAt !== undefined
    ? peerResetAt > now
    : now - observedAt < PEER_UNTIMED_MAX_AGE_MS;
  if (!current) return false;
  // -1 = unknown locally = unlimited; any known peer count is lower.
  return localRemaining === -1 || peerRemaining < localRemaining;
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

  /** Epoch ms of the last `update()` (this process's own server reading). */
  private lastObservedAt = 0;
  /** Epoch ms of the last peer read; throttles the reader. */
  private peerSyncedAt = 0;

  /** @param peerReader optional cross-process source (see module header). */
  constructor(private readonly peerReader?: PeerRateLimitReader) {}

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
    this.lastObservedAt = 0;
    this.peerSyncedAt = 0;
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
    this.lastObservedAt = Date.now();
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

  /**
   * Fold a peer observation into local state. Only ever tightens: a peer
   * freeze still in force extends ours (same clamp as {@link freeze}); a
   * peer count replaces ours only when it is lower, its window has not reset,
   * and it was read after our own last server response.
   */
  adoptPeer(peer: PeerRateLimitObservation, now: number = Date.now()): void {
    if (peer.frozenUntil !== undefined && peer.frozenUntil > now) {
      const capped = Math.min(peer.frozenUntil, now + RETRY_AFTER_MAX_WAIT_MS);
      if (capped > this.frozenUntil) this.frozenUntil = capped;
    }
    if (peer.observedAt <= this.lastObservedAt) return;
    if (peerCountApplies(peer.requestsRemaining, peer.requestsResetAt, peer.observedAt, now, this.requestsRemaining)) {
      this.requestsRemaining = peer.requestsRemaining;
      if (peer.requestsResetAt !== undefined) this.requestsResetAt = peer.requestsResetAt;
      if (this.requestsLimit === -1 && peer.requestsLimit !== undefined) this.requestsLimit = peer.requestsLimit;
    }
    if (peerCountApplies(peer.tokensRemaining, peer.tokensResetAt, peer.observedAt, now, this.inputTokensRemaining)) {
      this.inputTokensRemaining = peer.tokensRemaining;
      if (peer.tokensResetAt !== undefined) this.inputTokensResetAt = peer.tokensResetAt;
      if (this.inputTokensLimit === -1 && peer.tokensLimit !== undefined) this.inputTokensLimit = peer.tokensLimit;
    }
  }

  /** Throttled, fail-open peer read (at most once per {@link PEER_SYNC_INTERVAL_MS}). */
  private syncPeer(now: number): void {
    if (this.peerReader === undefined || now - this.peerSyncedAt < PEER_SYNC_INTERVAL_MS) return;
    this.peerSyncedAt = now;
    let peer: PeerRateLimitObservation | undefined;
    try {
      peer = this.peerReader();
    } catch {
      return; // Store failure = local-only behaviour.
    }
    if (peer !== undefined) this.adoptPeer(peer, now);
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

      // Adopt other processes' freezes / lower counts (throttled, fail-open).
      this.syncPeer(now);

      // Hard freeze from a 429 — wait out the retry-after.
      if (this.frozenUntil > now) {
        const waitMs = this.frozenUntil - now;
        await sleepWithAbort(waitMs, signal ?? new AbortController().signal);
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
      // When no reset timestamp is known but a dimension is exhausted, use a short
      // backoff (5 s) rather than 60 s so we converge quickly once headers arrive.
      // The 60 s fallback is kept for the truly-unknown case (both dimensions at -1
      // should have already returned via the pass-through above, but be defensive).
      const knownExhausted =
        this.requestsRemaining === 0 || this.inputTokensRemaining === 0;
      const defaultWaitMs = knownExhausted ? 5_000 : 60_000;
      const nextReset = candidates.length > 0 ? Math.min(...candidates) : now + defaultWaitMs;
      const sleepMs = Math.max(1, nextReset - now) + staggerJitterMs();

      await sleepWithAbort(sleepMs, signal ?? new AbortController().signal);
    }
  }
}

/**
 * Unkeyed, peer-less process-wide bucket. Kept for direct importers (tests,
 * ad-hoc wrappers); provider clients use the per-provider+account buckets
 * from `rate-limit-bucket.registry.ts` so one provider's headers never
 * overwrite another's state. Never shared with concurrency-pool or the
 * dispatch layer.
 */
export const globalRateLimitBucket = new RateLimitBucket();
