/**
 * OAuth-aware retry composition for {@link AnthropicDirectQuery}.
 *
 * Wraps `runTurn` with three retry layers (outermost first):
 *
 *   1. **Overload pause** — parks and re-probes after a mid-stream 529
 *      exhausts its in-loop budget. See `overload-pause-tier.ts`.
 *   2. **Usage-limit retry** — intercepts HTTP 429 errors carrying
 *      a `|<unix-ts>` reset timestamp, emits `paused`, waits via
 *      `waitForReset` (polling for token hot-swap or deadline), emits
 *      `resumed`, and replays the turn. Bounded at 2h reset window. Also
 *      honors transient `retry-after` backoff. See `usage-limit-tier.ts`
 *      and `usage-limit-pause.ts`.
 *   3. **Auth retry** (innermost) — on a single 401 from the SDK, calls
 *      `tokenRefresher` to obtain a fresh client, swaps it in, rebuilds
 *      headers, and replays the turn once. Subsequent 401s surface. See
 *      `auth-retry-tier.ts`.
 *
 * Both retry tiers deduplicate concurrent refresh / wait calls via
 * promise fields (`refreshPromise`, `usageLimitWaitPromise`) so multiple
 * sessions racing the same refresh see only one upstream call.
 *
 * # Structure
 *
 * This file is the orchestrator: it owns the mutable session state (client,
 * dedup promises, the stale-credential flag) and composes the tiers. Each
 * tier is a free async generator in a sibling module receiving a
 * {@link RetryTierContext} of live accessors — a class cannot be physically
 * split across files, and the tiers must observe post-construction mutations
 * (tests assign `tokenRefresher` after the fact) rather than captured values.
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
import { buildRequestHeaders } from '../auth.js';
import { isExtendedCacheTtlActive } from '../cache-policy.js';
import { loadClaudeCodeOauthToken, parseAccountIdentifier } from '../../../auth/keychain.js';
import { setRefreshedClaudeCodeOauthToken } from '../../../auth/credential-resolver.js';
import type { AnthropicClientLike, AuthMode, RunTurnInput } from '../types.js';
import type { RetryTierContext, UsageLimitWaitResult } from './retry-context.js';
import { turnWithAuthRetry } from './auth-retry-tier.js';
import { turnWithUsageLimitRetry } from './usage-limit-tier.js';
import { turnWithOverloadPause } from './overload-pause-tier.js';

// Re-exported so the historical `from './retry-layer.js'` import paths stay
// valid after the #824 split. `cli/quota-footer.ts` drift-tests against
// TWO_HOURS_MS, and the tier modules read the rest.
export {
  TWO_HOURS_MS,
  RATE_LIMIT_TRANSIENT_MAX_RETRIES,
  RATE_LIMIT_RETRY_MAX_WAIT_MS,
} from './retry-constants.js';
export type { RetryTierContext, UsageLimitWaitResult } from './retry-context.js';

/** Constructor options for {@link RetryLayer}. */
export interface RetryLayerOptions {
  client: Anthropic;
  authMode: AuthMode;
  initSessionId: string;
  /**
   * Session `baseUrl` (local-shim mode), forwarded verbatim to
   * `isExtendedCacheTtlActive` so replayed turns negotiate the 1h-cache beta
   * under exactly the same condition as the original send.
   */
  baseUrl?: string;
  /** Optional: called on 401 to obtain a fresh SDK client. Retry once per 401. */
  tokenRefresher?: () => Promise<Anthropic | null>;
  /** Whether to auto-wait+resume on 429 usage-limit (default true). */
  autoResumeOnUsageLimit: boolean;
  /**
   * User-facing surface that produced this session (`AgentConfig.surface`,
   * plumbed index.ts → query.ts → here). The ONLY consumer is
   * `resolveOverloadPauseCeilingMs`: interactive surfaces may park on an
   * upstream 529, daemon/cron must fail fast. Optional/back-compat — undefined
   * is treated as non-interactive (fail fast), which is the safe default.
   */
  surface?: string;
}

/**
 * Encapsulates both retry tiers and the writable SDK client. One instance
 * per session, constructed alongside {@link SessionState} and
 * {@link AbortCoordinator}.
 */
export class RetryLayer {
  private _client: Anthropic;
  /**
   * The OAuth token string the current `_client` was built with.
   *
   * `loadClaudeCodeOauthToken()` reads the credential STORE, which may already
   * contain account B when `/reauth` runs (the user ran `claude login` before
   * calling us). Comparing store-before vs store-after therefore yields
   * `swapped: false` even when the live client is switching from A to B.
   *
   * Tracking the token we actually wired into `_client` at construction (and
   * updating it on every client swap) lets `forceClientRefresh` compute
   * `swapped` against the running client's credential, not the store's
   * current value.
   */
  private _clientToken: string | undefined;
  private readonly _authMode: AuthMode;
  private readonly initSessionId: string;
  private readonly baseUrl?: string;
  private readonly tokenRefresher?: () => Promise<Anthropic | null>;
  private readonly autoResumeOnUsageLimit: boolean;
  private readonly surface?: string;

  private refreshPromise: Promise<Anthropic | null> | null = null;
  private usageLimitWaitPromise: Promise<UsageLimitWaitResult> | null = null;
  /**
   * Contract: set on the three paths where an OAuth usage-limit error
   * (`oauth-limit` / `oauth-limit-no-ts`) is surfaced to the caller WITHOUT a
   * replay — fail-fast (autoResumeOnUsageLimit=false) or the >2h reset bail —
   * so the credential snapshot this session holds may be stale by the time
   * the operator retries (e.g. they ran `claude login` to switch accounts
   * while the dead turn was failing). Consumed once at the top of the next
   * `turnWithRetries` call, which force-refreshes the client and clears the
   * flag unconditionally — see that method for why "unconditionally" matters.
   */
  private credentialSnapshotStale = false;

  constructor(opts: RetryLayerOptions) {
    this._client = opts.client;
    // Snapshot the token the initial client was built with. If the
    // constructor is called in OAuth mode the store holds the same value;
    // in api-key mode it is undefined (no OAuth token).
    //
    // Invariant: the constructor and the `opts.client` build both run in the
    // same synchronous frame, so `loadClaudeCodeOauthToken()` returns the same
    // value that was used to construct `opts.client`. This is safe as long as
    // the caller does not construct the client on one microtask and pass it here
    // on a later one (i.e. construction must be synchronous and sequential).
    this._clientToken = loadClaudeCodeOauthToken();
    this._authMode = opts.authMode;
    this.initSessionId = opts.initSessionId;
    this.baseUrl = opts.baseUrl;
    this.tokenRefresher = opts.tokenRefresher;
    this.autoResumeOnUsageLimit = opts.autoResumeOnUsageLimit;
    if (opts.surface !== undefined) this.surface = opts.surface;
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
   * Rebuild per-request headers for a replay (fresh request id). Re-evaluates
   * the 1h-cache beta rather than reusing the original header map, so a replay
   * never asks for a TTL whose activating beta it dropped.
   */
  private rotateHeaders(runInput: Pick<RunTurnInput, 'effort' | 'fastMode' | 'thinkingBlockBinding'>): Record<string, string> {
    return buildRequestHeaders(
      this._authMode,
      this.initSessionId,
      randomUUID(),
      runInput.effort !== undefined,
      isExtendedCacheTtlActive({ ...(this.baseUrl !== undefined ? { baseUrl: this.baseUrl } : {}) }),
      runInput.fastMode === true,
      runInput.thinkingBlockBinding !== undefined,
    );
  }

  /**
   * Live view handed to the extracted tiers.
   *
   * Invariant: every member is a getter or a method, never a captured value.
   * `tokenRefresher` is assigned after construction by the OAuth retry suite,
   * and `getClient()` must return the post-swap reference — snapshotting
   * either would silently disable refresh-and-replay.
   */
  private tierContext(): RetryTierContext {
    const layer = this;
    return {
      get authMode() {
        return layer._authMode;
      },
      get surface() {
        return layer.surface;
      },
      get autoResumeOnUsageLimit() {
        return layer.autoResumeOnUsageLimit;
      },
      get tokenRefresher() {
        return layer.tokenRefresher;
      },
      getClient: () => layer._client,
      getClientToken: () => layer._clientToken,
      rotateHeaders: (runInput) => layer.rotateHeaders(runInput),
      forceClientRefresh: () => layer.forceClientRefresh(),
      getUsageLimitWait: () => layer.usageLimitWaitPromise,
      setUsageLimitWait: (p) => {
        layer.usageLimitWaitPromise = p;
      },
      markCredentialSnapshotStale: () => {
        layer.credentialSnapshotStale = true;
      },
    };
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
   *   - The hot-swap branches of the usage-limit tier (mid-turn, after a
   *     keychain token change is detected by the wait loops).
   *   - The `/reauth` slash command (between turns, when the user manually
   *     requests an account swap or proactive refresh).
   *
   * Returns `null` when:
   *   - No `tokenRefresher` is wired (api-key mode, or local-server mode).
   *   - The refresher returned null (token read/refresh failed).
   *
   * Returns `{ accountId, oldAccountId, swapped }` on success, where `swapped`
   * is `true` iff the new client's underlying token differs from the previous
   * one. `oldAccountId` is the account id parsed from the token the old client
   * was built with (useful for the `/reauth` message "switched from X to Y").
   * Callers (e.g. `/reauth`) can use `swapped` to distinguish "now on a
   * different account" from "the existing token was already current".
   *
   * Deduplicates concurrent calls via {@link refreshPromise} — the same field
   * the 401 path uses, so a 401-driven refresh racing with an explicit
   * `/reauth` collapses to a single upstream call.
   */
  async forceClientRefresh(): Promise<{ accountId: string; oldAccountId: string; swapped: boolean } | null> {
    if (!this.tokenRefresher) return null;
    // Capture the token the CURRENT CLIENT was built with. This is the correct
    // baseline for "did we just swap accounts?". Reading loadClaudeCodeOauthToken()
    // here instead would return the STORE's current value — which is already
    // account B when the user ran `claude login` before calling `/reauth`,
    // producing store-before === store-after and a false `swapped: false`.
    const priorClientToken = this._clientToken;

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
    // Contract: `tokenRefresher` is expected to build its client from the same
    // credential store that `loadClaudeCodeOauthToken()` reads. Therefore reading
    // the store immediately after the refresher returns captures the token the new
    // client was built with. If a future refresher implementation builds from a
    // different source, `_clientToken` must be updated to match that source here.
    const newToken = loadClaudeCodeOauthToken();
    // Update the tracked token to match what the new client was built with.
    this._clientToken = newToken;
    // Fix #2471 (resolver-cache fallback): when the live store is temporarily
    // unreadable (write-back failed, keychain locked), `loadAnthropicCredential()`
    // falls through to its process-local cache — which still held the boot-time
    // token. Update the cache here so every subsequent resolver read returns the
    // fresh account's token, not the boot-time one.
    if (newToken) setRefreshedClaudeCodeOauthToken(newToken);
    return {
      accountId: parseAccountIdentifier(newToken ?? ''),
      // Skip parseAccountIdentifier when the prior token was nullish: passing ''
      // returns the truthy sentinel 'token:(unknown)', which the caller must then
      // special-case. Passing '' directly instead lets the caller distinguish
      // "no prior account" from "account with undecodable token" cleanly.
      oldAccountId: priorClientToken != null ? parseAccountIdentifier(priorClientToken) : '',
      swapped: priorClientToken !== newToken,
    };
  }

  /**
   * Run a single turn through every retry tier. `isClosed` is invoked
   * between events; when it returns true the generator short-circuits
   * so a concurrent `close()` cuts the turn off cleanly.
   *
   * The caller passes `runInput` already populated with the current
   * client (read via {@link client}) and signal (from
   * `AbortCoordinator.begin()`); on a successful 401 refresh the layer
   * mutates `runInput.client` and `runInput.headers` in place before
   * replaying, so the second pass sees the new client.
   *
   * Contract: if the PREVIOUS turn ended by surfacing a usage-limit error
   * without a replay (`credentialSnapshotStale`), force one credential
   * re-resolve before this turn runs — the operator's fix (`claude login` to
   * a different account) may have landed while no poller was alive to pick it
   * up (fail-fast paths, e.g. subagent forks, don't wait/poll at all). Clears
   * the flag UNCONDITIONALLY, even when the refresh returns `null` (api-key
   * mode, or the refresh attempt itself failed) — leaving it set would force
   * a refresh on every subsequent turn forever.
   */
  async *turnWithRetries(
    runInput: RunTurnInput,
    isClosed: () => boolean,
  ): AsyncGenerator<ProviderEvent, void, void> {
    if (this.credentialSnapshotStale) {
      const refreshed = await this.forceClientRefresh();
      if (refreshed) {
        runInput.client = this._client as unknown as AnthropicClientLike;
        runInput.headers = this.rotateHeaders(runInput);
      }
      this.credentialSnapshotStale = false;
    }
    // Tier composition, outermost first: overload pause → usage limit → auth.
    // Each tier receives the next as an explicit parameter, preserving the
    // nesting the single-file version expressed through direct method calls.
    const ctx = this.tierContext();
    yield* turnWithOverloadPause(ctx, runInput, isClosed, (c, input, closed) =>
      turnWithUsageLimitRetry(c, input, closed, turnWithAuthRetry),
    );
  }
}
