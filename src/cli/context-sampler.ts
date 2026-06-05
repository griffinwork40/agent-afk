/**
 * Cached, sampled view of `session.getContextUsage()` for the status line.
 *
 * The status line repaints every turn; hitting the SDK every repaint is
 * both chatty and redundant (the value only changes when a new turn
 * actually consumed tokens). This sampler:
 *
 *   - caches the last-good ratio (`percentage / 100`) so
 *     repaints are O(1) cache reads;
 *   - refreshes on a per-N-turns cadence (`onTurn(turnIndex)`), keeping
 *     the hot path fast;
 *   - dedupes overlapping fetches — a second `refresh()` while a fetch
 *     is in-flight returns the same promise;
 *   - degrades gracefully: if a fetch rejects, the last-good cache is
 *     preserved rather than reset to undefined.
 *
 * The sampler is session-scoped; each `AgentSession` gets its own.
 */

import type { AgentSession } from '../agent/session.js';

export interface ContextSamplerOptions {
  /** How many user turns between samples. Defaults to 3. */
  sampleEveryNTurns?: number;
}

/** Narrow session surface used by the sampler — simplifies testing. */
interface ContextUsageSource {
  getContextUsage(): Promise<{
    apiUsage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    } | null;
    percentage?: number;
    totalTokens?: number;
    maxTokens?: number;
    autoCompactThreshold?: number;
    isAutoCompactEnabled: boolean;
    [key: string]: unknown;
  }>;
}

export class ContextSampler {
  private source: ContextUsageSource;
  private readonly sampleEveryNTurns: number;
  private cachedRatio: number | undefined;
  private cachedDetail: { used: number; limit: number; percentage: number } | undefined;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  /**
   * Monotonically-increasing counter bumped on every attach(). In-flight
   * promises capture the generation at launch time and discard their result
   * if the generation has advanced by the time they resolve — preventing a
   * slow fetch from the old session from overwriting the new session's cache
   * after a mid-session swap.
   */
  private generation = 0;

  constructor(source: ContextUsageSource, opts: ContextSamplerOptions = {}) {
    this.source = source;
    this.sampleEveryNTurns = opts.sampleEveryNTurns ?? 3;
  }

  /**
   * Rebind the sampler to a new session source (e.g. after a mid-session
   * swap). Clears the cached ratio and detail so the next repaint fetches
   * fresh data from the new session. Bumps the generation counter so any
   * in-flight fetch from the previous source discards its result on resolve
   * rather than overwriting the new session's cache.
   */
  attach(session: AgentSession): this {
    this.source = session;
    this.generation += 1;
    this.reset();
    return this;
  }

  /** Latest cached ratio, or undefined if we haven't fetched successfully yet. */
  getRatio(): number | undefined {
    return this.cachedRatio;
  }

  /** Latest cached detail (used, limit, percentage), or undefined if we haven't fetched successfully yet. */
  getDetail(): { used: number; limit: number; percentage: number } | undefined {
    return this.cachedDetail;
  }

  /** Fetch once and update the cache. Dedupes concurrent calls. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) return this.inFlight;
    const promise = this.doFetch().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  /**
   * Hook the status-line driver calls after each turn. Decides whether
   * this turn warrants a new fetch based on the configured cadence.
   */
  async onTurn(turnIndex: number): Promise<void> {
    if (this.disposed) return;
    // `turnIndex % N === 1` samples on turn 1, N+1, 2N+1, …
    // That gives an early first reading and a steady cadence afterwards.
    if (turnIndex % this.sampleEveryNTurns !== 1) return;
    await this.refresh();
  }

  /**
   * Clear cached values so the next repaint starts from zero.
   *
   * **Known limitation:** `inFlight` is set to `null` here, but the
   * underlying `doFetch()` Promise (if one was in flight) is not aborted —
   * it continues until the SDK call resolves or rejects. The result is
   * discarded via the `generation` guard in `doFetch()` (the generation is
   * bumped by `attach()` before `reset()` is called on a mid-session swap),
   * so stale results never overwrite the new session's cache. The cost is a
   * single un-cancellable `getContextUsage()` RPC after a swap — acceptable
   * for a status-line sampler. A full AbortController threading would
   * require plumbing through to the SDK client; deferred until needed.
   */
  reset(): void {
    this.cachedRatio = undefined;
    this.cachedDetail = undefined;
    this.inFlight = null;
  }

  /** Stop any future sampling. Safe to call multiple times. */
  dispose(): void {
    this.disposed = true;
  }

  private async doFetch(): Promise<void> {
    // Snapshot the generation at dispatch time. If attach() is called while
    // this fetch is in-flight the generation advances and we discard the stale
    // result below rather than overwriting the new session's cache.
    const capturedGeneration = this.generation;
    try {
      const payload = await this.source.getContextUsage();

      // Discard results from a superseded source (generation mismatch).
      if (this.generation !== capturedGeneration) return;

      const used = computeTotalTokens(payload.apiUsage);
      const limit = payload.maxTokens ?? 0;
      const percentage = payload.percentage;

      // Update ratio from percentage (API's authoritative value)
      if (typeof percentage === 'number') {
        this.cachedRatio = Math.min(1, Math.max(0, percentage / 100));
        // Store detail for consumers that need the breakdown
        this.cachedDetail = { used, limit, percentage };
      }
      // No percentage → leave cachedRatio and cachedDetail as-is
    } catch {
      // Keep the last-good cache. Transient SDK errors should not blank
      // the status line.
    }
  }
}

function computeTotalTokens(
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null | undefined,
): number {
  if (!usage) return 0;
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  );
}
