/**
 * OAuth-aware retry composition for {@link AnthropicDirectQuery}.
 *
 * Wraps `runTurn` with two retry layers (outer first, inner second):
 *
 *   1. **Usage-limit retry** (outer) — intercepts HTTP 429 errors carrying
 *      a `|<unix-ts>` reset timestamp, emits `paused`, waits via
 *      `waitForReset` (polling for token hot-swap or deadline), emits
 *      `resumed`, and replays the turn. Bounded at 2h reset window.
 *   2. **Auth retry** (inner) — on a single 401 from the SDK, calls
 *      `tokenRefresher` to obtain a fresh client, swaps it in, rebuilds
 *      headers, and replays the turn once. Subsequent 401s surface.
 *
 * Both retry tiers deduplicate concurrent refresh / wait calls via
 * promise fields (`refreshPromise`, `usageLimitWaitPromise`) so multiple
 * sessions racing the same refresh see only one upstream call.
 *
 * # Writable client
 *
 * `client` is the only mutable field here. It is swapped on a successful
 * 401 refresh and read by `compact()` for its summarization request. The
 * orchestrator exposes the latest value through {@link RetryLayer.client}
 * so the compact path always sees the post-swap reference.
 *
 * # Why `authMode` and `initSessionId` live here
 *
 * Both are needed inside the retry generators to rebuild request headers
 * after a client swap or a usage-limit resume. They are also accessed by
 * other paths (compact, accountInfo, the outer loop's per-turn header
 * build); the orchestrator reads them back from this layer's getters so
 * the session has one source of truth.
 *
 * @module agent/providers/anthropic-direct/query/retry-layer
 */

import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { ProviderEvent } from '../../../provider.js';
import { runTurn } from '../loop.js';
import { buildRequestHeaders } from '../auth.js';
import { classifyUsageLimitError, waitForReset, waitForHotSwap } from '../usage-limit.js';
import { loadClaudeCodeOauthToken, parseAccountIdentifier } from '../../../../cli/keychain.js';
import type {
  AnthropicClientLike,
  AuthMode,
  RunTurnInput,
} from '../types.js';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// Invariant: a 429 with no reset timestamp gives no deadline to wait on, so the
// no-ts path poll-retries the turn on this fixed cadence to probe whether the
// limit has lifted (while still waking immediately on a keychain hot-swap).
// Each probe is a single cheap rejected request; the loop is bounded at
// TWO_HOURS_MS total so a never-resetting limit eventually surfaces the error.
const NO_TS_RETRY_INTERVAL_MS = 60 * 1000;

/** Constructor options for {@link RetryLayer}. */
export interface RetryLayerOptions {
  client: Anthropic;
  authMode: AuthMode;
  initSessionId: string;
  /** Optional: called on 401 to obtain a fresh SDK client. Retry once per 401. */
  tokenRefresher?: () => Promise<Anthropic | null>;
  /** Whether to auto-wait+resume on 429 usage-limit (default true). */
  autoResumeOnUsageLimit: boolean;
}

/**
 * Encapsulates both retry tiers and the writable SDK client. One instance
 * per session, constructed alongside {@link SessionState} and
 * {@link AbortCoordinator}.
 */
export class RetryLayer {
  private _client: Anthropic;
  private readonly _authMode: AuthMode;
  private readonly initSessionId: string;
  private readonly tokenRefresher?: () => Promise<Anthropic | null>;
  private readonly autoResumeOnUsageLimit: boolean;

  private refreshPromise: Promise<Anthropic | null> | null = null;
  private usageLimitWaitPromise: Promise<'aborted' | 'timer' | 'hot-swap'> | null = null;

  constructor(opts: RetryLayerOptions) {
    this._client = opts.client;
    this._authMode = opts.authMode;
    this.initSessionId = opts.initSessionId;
    this.tokenRefresher = opts.tokenRefresher;
    this.autoResumeOnUsageLimit = opts.autoResumeOnUsageLimit;
  }

  /**
   * Current SDK client. Returns the latest post-swap reference so callers
   * like `compact()` always see the up-to-date client.
   */
  get client(): Anthropic {
    return this._client;
  }

  /** Auth mode the session was constructed with. Immutable. */
  get authMode(): AuthMode {
    return this._authMode;
  }

  /**
   * Force a fresh SDK client by invoking the configured `tokenRefresher`.
   *
   * The `Anthropic` SDK reads `authToken` once at construction and caches it
   * on the client instance (see `client.mjs` — `this.authToken = authToken`,
   * then `Authorization: Bearer ${this.authToken}` per request). When the
   * keychain blob changes (because `claude /login` wrote a fresh token for a
   * different account), rebuilding only request headers is **not** enough —
   * the SDK will keep sending the original `Authorization` header forever.
   * We have to construct a new client.
   *
   * Used by:
   *   - The hot-swap branches of {@link turnWithUsageLimitRetry} (mid-turn,
   *     after a keychain token change is detected by the wait loops).
   *   - The `/reauth` slash command (between turns, when the user manually
   *     requests an account swap or proactive refresh).
   *
   * Returns `null` when:
   *   - No `tokenRefresher` is wired (api-key mode, or local-server mode).
   *   - The refresher returned null (token read/refresh failed).
   *
   * Returns `{ accountId, swapped }` on success, where `swapped` is `true`
   * iff the new client's underlying token differs from the previous one.
   * Callers (e.g. `/reauth`) can use `swapped` to distinguish "now on a
   * different account" from "the existing token was already current".
   *
   * Deduplicates concurrent calls via {@link refreshPromise} — the same field
   * the 401 path uses, so a 401-driven refresh racing with an explicit
   * `/reauth` collapses to a single upstream call.
   */
  async forceClientRefresh(): Promise<{ accountId: string; swapped: boolean } | null> {
    if (!this.tokenRefresher) return null;
    const priorToken = loadClaudeCodeOauthToken();

    let newClient: Anthropic | null = null;
    try {
      if (this.refreshPromise) {
        newClient = await this.refreshPromise;
      } else {
        this.refreshPromise = this.tokenRefresher();
        try {
          newClient = (await this.refreshPromise) ?? null;
        } finally {
          this.refreshPromise = null;
        }
      }
    } catch {
      this.refreshPromise = null;
      return null;
    }
    if (!newClient) return null;

    this._client = newClient;
    const newToken = loadClaudeCodeOauthToken();
    return {
      accountId: parseAccountIdentifier(newToken ?? ''),
      swapped: priorToken !== newToken,
    };
  }

  /**
   * Run a single turn through both retry tiers. `isClosed` is invoked
   * between events; when it returns true the generator short-circuits
   * so a concurrent `close()` cuts the turn off cleanly.
   *
   * The caller passes `runInput` already populated with the current
   * client (read via {@link client}) and signal (from
   * `AbortCoordinator.begin()`); on a successful 401 refresh the layer
   * mutates `runInput.client` and `runInput.headers` in place before
   * replaying, so the second pass sees the new client.
   */
  async *turnWithRetries(
    runInput: RunTurnInput,
    isClosed: () => boolean,
  ): AsyncGenerator<ProviderEvent, void, void> {
    yield* this.turnWithUsageLimitRetry(runInput, isClosed);
  }

  /**
   * Outer tier: intercept 429 usage-limit errors and (when enabled)
   * wait+replay. Deduplicates concurrent wait calls via
   * {@link usageLimitWaitPromise}.
   *
   * Handles two sub-kinds:
   *   - `oauth-limit`      — 429 with `|<unix-ts>` reset timestamp: wait for
   *     the deadline (or a hot-swap), then replay. Reset windows beyond 2h are
   *     surfaced immediately without waiting.
   *   - `oauth-limit-no-ts` — 429 without a timestamp (API omitted it): emit
   *     `paused` with no `resetsAt`, then poll-retry the turn on a fixed cadence
   *     (and wake immediately on a hot-swap) until the limit lifts, the user
   *     aborts, or the 2h cap is hit. Stays in the `paused` state across failed
   *     probes and emits `resumed` only once the limit genuinely lifts.
   */
  private async *turnWithUsageLimitRetry(
    runInput: RunTurnInput,
    isClosed: () => boolean,
  ): AsyncGenerator<ProviderEvent, void, void> {
    let pendingErrorEvent: ProviderEvent | null = null;
    let resetsAt: Date | null = null;
    let noTimestamp = false;

    for await (const event of this.turnWithAuthRetry(runInput, isClosed)) {
      if (event.type === 'error') {
        const c = classifyUsageLimitError(event.error);
        if (c && c.kind === 'oauth-limit') {
          resetsAt = c.resetsAt;
          pendingErrorEvent = event;
          break;
        }
        if (c && c.kind === 'oauth-limit-no-ts') {
          noTimestamp = true;
          pendingErrorEvent = event;
          break;
        }
        // `rate-limit-transient` (a standard API rate-limit 429, distinct from
        // OAuth subscription exhaustion) intentionally does NOT break into the
        // wait/pause path below. The SDK has already auto-retried it honoring
        // `retry-after`; a still-failing 429 here is surfaced as an error via
        // the `yield event` below rather than parked in a 2-hour
        // subscription-reset poll. See classifyUsageLimitError.
      }
      yield event;
    }

    if (!pendingErrorEvent) {
      return;
    }

    // ── oauth-limit-no-ts path ─────────────────────────────────────────────
    // No reset timestamp available, so there is no authoritative deadline to
    // wait on. We poll-retry the turn on NO_TS_RETRY_INTERVAL_MS — replaying to
    // probe whether the limit has lifted — while still waking immediately on a
    // keychain hot-swap. We stay in the `paused` state across failed probes and
    // emit `resumed` only once the limit genuinely lifts, so the UI's
    // "auto-resume when the limit resets" promise is actually kept on a
    // same-account reset (previously this path waited on a hot-swap ONLY, so a
    // same-account reset never resumed and the session hung forever). Bounded at
    // TWO_HOURS_MS — past that the error surfaces instead of polling forever.
    if (noTimestamp) {
      const accountId = parseAccountIdentifier(loadClaudeCodeOauthToken() ?? '');
      yield { type: 'paused', reason: 'usage-limit', accountId, autoResume: this.autoResumeOnUsageLimit };

      if (!this.autoResumeOnUsageLimit) {
        yield pendingErrorEvent;
        return;
      }

      const startedAt = Date.now();
      let resumeEmitted = false;
      for (;;) {
        let noTsResult: 'aborted' | 'hot-swap' | 'timer';
        if (this.usageLimitWaitPromise) {
          // A concurrent session already waiting — dedup by treating any
          // resolve as 'aborted' since we can't share this wait.
          noTsResult = 'aborted';
        } else {
          this.usageLimitWaitPromise = waitForHotSwap({
            signal: runInput.signal,
            retryAfterMs: NO_TS_RETRY_INTERVAL_MS,
          });
          try {
            noTsResult = await this.usageLimitWaitPromise;
          } finally {
            this.usageLimitWaitPromise = null;
          }
        }

        if (noTsResult === 'aborted') return;

        let resumedAccountId = accountId;
        if (noTsResult === 'hot-swap') {
          // hot-swap: new token in keychain. The Anthropic SDK caches
          // `authToken` at construction, so we MUST rebuild the client — not
          // just the headers — or the replayed turn keeps sending the prior
          // account's bearer token and re-hits the same 429. On refresh failure
          // fall through with the existing client (mirrors the oauth-limit hot-
          // swap path); the timer probe may still succeed once the same-account
          // limit resets.
          const refreshed = await this.forceClientRefresh();
          if (refreshed) {
            runInput.client = this._client as unknown as AnthropicClientLike;
            resumedAccountId = refreshed.accountId;
          }
        }
        runInput.headers = buildRequestHeaders(
          this._authMode,
          this.initSessionId,
          randomUUID(),
        );

        // Replay the turn. Peek the stream: if the FIRST thing it does is
        // re-hit a usage limit we are still limited — stay paused and wait
        // again. Otherwise the limit lifted: emit `resumed` once, then stream.
        let reLimited: ProviderEvent | null = null;
        for await (const event of this.turnWithAuthRetry(runInput, isClosed)) {
          if (!resumeEmitted && event.type === 'error') {
            const c = classifyUsageLimitError(event.error);
            if (c && (c.kind === 'oauth-limit' || c.kind === 'oauth-limit-no-ts')) {
              reLimited = event;
              break;
            }
          }
          if (!resumeEmitted) {
            yield { type: 'resumed', hotSwapped: noTsResult === 'hot-swap', accountId: resumedAccountId };
            resumeEmitted = true;
          }
          yield event;
        }

        // Resumed (or the turn ended without re-limiting) — done.
        if (!reLimited) return;

        if (Date.now() - startedAt > TWO_HOURS_MS) {
          // Limit never lifted within the cap — stop polling and surface it.
          yield reLimited;
          return;
        }
        // Still limited — loop and wait again (we remain in the paused state).
      }
    }

    // ── oauth-limit path (has reset timestamp) ────────────────────────────
    if (!resetsAt) {
      return;
    }

    if (resetsAt.getTime() - Date.now() > TWO_HOURS_MS) {
      // Reset too far in the future — surface the error without waiting.
      yield pendingErrorEvent;
      return;
    }

    const accountId = parseAccountIdentifier(loadClaudeCodeOauthToken() ?? '');
    // External constraint: this event must carry `autoResume` BEFORE the
    // autoResumeOnUsageLimit branch below decides what comes next, so the UI
    // layer can render truthful copy on the very first paint of the panel.
    // If we deferred this signal to the resumed/error event, the panel would
    // briefly mislead the user with stale "send the message again" instructions.
    yield {
      type: 'paused',
      reason: 'usage-limit',
      resetsAt,
      accountId,
      autoResume: this.autoResumeOnUsageLimit,
    };

    if (!this.autoResumeOnUsageLimit) {
      yield pendingErrorEvent;
      return;
    }

    let result: 'aborted' | 'timer' | 'hot-swap';
    if (this.usageLimitWaitPromise) {
      result = await this.usageLimitWaitPromise;
    } else {
      this.usageLimitWaitPromise = waitForReset({ resetsAt, signal: runInput.signal });
      try {
        result = await this.usageLimitWaitPromise;
      } finally {
        this.usageLimitWaitPromise = null;
      }
    }

    if (result === 'aborted') return;

    let resumedAccountId = accountId;
    if (result === 'hot-swap') {
      // hot-swap: user logged into a different account during the wait. Same
      // SDK-caches-authToken constraint as the no-ts path above — rebuild
      // the client or the replayed turn keeps using the prior account's
      // bearer token.
      const refreshed = await this.forceClientRefresh();
      if (refreshed) {
        runInput.client = this._client as unknown as AnthropicClientLike;
        resumedAccountId = refreshed.accountId;
      }
      // If refresh failed, fall through with the old client — the inner
      // 401 path may still recover if the prior token has since expired.
    }
    // 'timer' resolution: deadline passed, same account, same token — no
    // client rebuild needed. Headers still rotated to refresh the request-id.
    runInput.headers = buildRequestHeaders(
      this._authMode,
      this.initSessionId,
      randomUUID(),
    );
    yield { type: 'resumed', hotSwapped: result === 'hot-swap', accountId: resumedAccountId };

    yield* this.turnWithAuthRetry(runInput, isClosed);
  }

  /**
   * Inner tier: on a single 401, refresh once and replay. Deduplicates
   * concurrent refresh calls via {@link refreshPromise}.
   */
  private async *turnWithAuthRetry(
    runInput: RunTurnInput,
    isClosed: () => boolean,
  ): AsyncGenerator<ProviderEvent, void, void> {
    let authError: ProviderEvent | null = null;

    for await (const event of runTurn(runInput)) {
      if (isClosed()) return;
      if (event.type === 'error' && this.isRetryableAuth(event.error)) {
        authError = event;
        break;
      }
      yield event;
    }

    if (!authError) return;

    // Delegate to the shared refresh helper. Same dedup field
    // (`refreshPromise`) coalesces this call with any concurrent
    // `forceClientRefresh()` from `/reauth` or a hot-swap branch above.
    const refreshed = await this.forceClientRefresh();
    if (!refreshed) {
      yield authError;
      return;
    }
    runInput.client = this._client as unknown as AnthropicClientLike;
    runInput.headers = buildRequestHeaders(
      this._authMode,
      this.initSessionId,
      randomUUID(),
    );

    yield* runTurn(runInput);
  }

  private isRetryableAuth(error: Error): boolean {
    return (
      this._authMode === 'oauth' &&
      this.tokenRefresher !== undefined &&
      'status' in error &&
      (error as unknown as { status: number }).status === 401
    );
  }
}
