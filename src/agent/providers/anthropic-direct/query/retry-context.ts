/**
 * The narrow view of {@link RetryLayer} that its extracted tiers operate on.
 *
 * # Why a context object rather than methods on the class
 *
 * The retry tiers were extracted from `retry-layer.ts` (#824 split) to hold
 * every module under the 350-LOC budget. A TypeScript class cannot be
 * physically continued across files — private fields are not reachable from a
 * sibling module — so each tier became a free async generator taking this
 * context, and the class kept one-line `yield*` delegates. Same call order,
 * same mutations, same events.
 *
 * # Invariant: every accessor reads LIVE state
 *
 * Nothing here may be snapshotted at construction. `tokenRefresher` in
 * particular is assigned AFTER construction by the OAuth retry suite
 * (`query-auth-retry.test.ts` sets `query.retry.tokenRefresher = mock`), and
 * `getClient()` must observe the post-swap reference a 401 refresh installed.
 * Capturing either by value would silently disable the refresh-and-replay path
 * — the exact regression this split must not introduce.
 *
 * @module agent/providers/anthropic-direct/query/retry-context
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ProviderEvent } from '../../../provider.js';
import type { AuthMode, RunTurnInput } from '../types.js';

/** Resolution of a usage-limit wait: user abort, deadline reached, or token swap. */
export type UsageLimitWaitResult = 'aborted' | 'timer' | 'hot-swap';

/** A retry tier: consumes a turn's events and re-emits them, replaying as needed. */
export type TierGenerator = (
  ctx: RetryTierContext,
  runInput: RunTurnInput,
  isClosed: () => boolean,
) => AsyncGenerator<ProviderEvent, void, void>;

/** Live accessors the extracted retry tiers need from the owning {@link RetryLayer}. */
export interface RetryTierContext {
  /** Auth mode the session was constructed with. Immutable. */
  readonly authMode: AuthMode;
  /** User-facing surface; the only consumer is the overload-pause ceiling. */
  readonly surface: string | undefined;
  /** Whether to auto-wait+resume on a 429 usage limit. */
  readonly autoResumeOnUsageLimit: boolean;
  /** Read LIVE — tests install this after construction. */
  readonly tokenRefresher: (() => Promise<Anthropic | null>) | undefined;
  /** Latest client reference, post-swap. */
  getClient(): Anthropic;
  /** Rebuild per-request headers for a replay (fresh request id, re-evaluated betas). */
  rotateHeaders(runInput: Pick<RunTurnInput, 'effort' | 'fastMode'>): Record<string, string>;
  /** Refresh the SDK client via `tokenRefresher`, deduplicated across callers. */
  forceClientRefresh(): Promise<{ accountId: string; swapped: boolean } | null>;
  /** In-flight usage-limit wait, shared so concurrent sessions dedup. */
  getUsageLimitWait(): Promise<UsageLimitWaitResult> | null;
  setUsageLimitWait(p: Promise<UsageLimitWaitResult> | null): void;
  /** Mark the held credential snapshot stale so the NEXT turn re-resolves it. */
  markCredentialSnapshotStale(): void;
}
