/**
 * Client, auth, throttle and quota wiring for one
 * `AnthropicDirectProvider.query()` call.
 *
 * Extracted from `index.ts` (#824). Owns everything between "we have a token"
 * and "we have a live Anthropic client", including the observability plumbing
 * that must survive an OAuth token refresh.
 *
 * Invariant: the `throttleQueue` and `quotaObserver` created here are wired
 * into BOTH the initial client and any client rebuilt by `tokenRefresher`.
 * The queue is a rendezvous — the tracing fetch is the producer, the per-turn
 * loop is the consumer — so handing the rebuilt client a fresh queue would
 * silently strand the live rate-limit banner after an account swap. The same
 * instance must reach `AnthropicDirectQuery`.
 *
 * Note the two gates differ deliberately and must not be unified:
 *   - `throttleQueue` is gated on `!localMode && config.traceWriter`.
 *   - `quotaObserver` is gated on `!localMode` ALONE — the quota headers feed
 *     the CLI status line, which must stay live when tracing is disabled.
 *   - `rateLimitObserver` feeds the admission bucket and is gated on
 *     `!localMode` ALONE — local shims have no meaningful per-minute limits.
 *
 * @module agent/providers/anthropic-direct/query/client-setup
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../../../types/config-types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { buildClientOptions, buildSystemPrefix } from '../auth.js';
import type { AuthMode } from '../types.js';
import { makeTracingFetch } from '../tracing-fetch.js';
import { ThrottleQueue } from '../throttle-queue.js';
import { parseQuotaHeaders, recordQuotaSnapshot } from '../../../quota-cache.js';
import { refreshClaudeCodeOauthToken } from '../../../auth/keychain.js';
import type { AnthropicClientFactory } from '../provider-options.js';
import { globalRateLimitBucket } from '../../shared/rate-limit-bucket.js';
import { parseAnthropicRateLimitHeaders } from '../../shared/rate-limit-headers.js';

export interface ClientSetupArgs {
  config: AgentConfig;
  token: string;
  authMode: AuthMode;
  localMode: boolean;
  /** Resolved factory (`providerFactory ?? module hook`), or null for the real SDK. */
  factory: AnthropicClientFactory | null | undefined;
  /** Constructor used when no factory is installed. */
  createClient: (opts: ReturnType<typeof buildClientOptions>) => Anthropic;
}

export interface ClientSetup {
  client: Anthropic;
  /** Live rate-limit mailbox; undefined when not installed. */
  throttleQueue: ThrottleQueue | undefined;
  /** OAuth CLI-mimicry billing prefix, or null when suppressed. */
  systemPrefix: ContentBlockParam[] | null;
  /** Rebuilds the client against a freshly-refreshed OAuth token. */
  tokenRefresher?: (() => Promise<Anthropic | null>) | undefined;
}

/**
 * Build the SDK client plus its observability wrappers, and — for OAuth
 * sessions against the real endpoint — the refresher that rebuilds it.
 */
export function setUpQueryClient(args: ClientSetupArgs): ClientSetup {
  const { config, localMode, authMode, factory } = args;

  // Live-throttle mailbox: the wrapped fetch pushes a signal onto this queue
  // for every 429/503/529 the SDK sleep-and-retries INSIDE a single
  // `messages.create`; the per-turn loop drains it to surface a `rate_limit`
  // ProviderEvent LIVE (the loop is otherwise parked awaiting the SDK and
  // cannot yield during the backoff). Installed only when the tracing fetch
  // is (non-local-shim + a trace writer OR a live surface would consume it) —
  // here it rides alongside the existing trace-writer gate so the queue and
  // the wrapper share the same lifetime. The SAME instance is handed to the
  // query so the fetch producer and the loop consumer meet.
  const throttleQueue =
    !localMode && config.traceWriter ? new ThrottleQueue() : undefined;
  // Invariant: quota capture is gated on `!localMode` ALONE — deliberately not
  // on `config.traceWriter`. The `anthropic-ratelimit-unified-*` headers ride
  // on every response and feed the CLI status line, which must stay live even
  // when tracing is off (`AFK_TRACE_DISABLED=1`); tying it to the trace writer
  // would silently blank the indicator in that configuration. localMode is
  // still excluded: a local shim is not Anthropic and emits no quota headers.
  const quotaObserver = localMode
    ? undefined
    : (headers: Headers): void => {
        const snapshot = parseQuotaHeaders(headers);
        if (snapshot !== undefined) recordQuotaSnapshot(snapshot);
      };

  // Rate-limit admission observer: captures per-minute RPM/ITPM/OTPM headers
  // from every Anthropic response and feeds the process-wide admission bucket.
  // Gated on !localMode — local shims have no meaningful per-minute limits
  // and should never be artificially throttled by the bucket.
  const rateLimitObserver = localMode
    ? undefined
    : (headers: Headers): void => {
        const snapshot = parseAnthropicRateLimitHeaders(headers);
        if (snapshot !== undefined) globalRateLimitBucket.update(snapshot);
      };

  // Admission gate: skip in localMode — same rationale as rateLimitObserver.
  const admissionGate = localMode ? undefined : globalRateLimitBucket;

  const clientOpts = buildClientOptions(
    args.token,
    authMode,
    config.baseUrl,
    // Observability: route SDK HTTP through a wrapper that (1) waits for an
    // admission permit before each request (pre-request admission gate for
    // RPM/ITPM), (2) records 429/503/529 throttling into the witness trace so
    // the SDK's otherwise-silent retry-after backoff is legible in `afk trace
    // show`, (3) pushes a live signal onto `throttleQueue` so the progress
    // banner can show the backoff as it happens, (4) captures subscription-quota
    // headers into the quota cache for the status line, and (5) feeds per-minute
    // RPM/ITPM headers into the admission bucket. Skipped entirely in local-shim
    // mode (not Anthropic's billing surface). Note the wrapper is installed
    // whenever ANY of the observers is live — a trace writer is no longer
    // required, since (4) must work with tracing disabled.
    !localMode
      ? makeTracingFetch(
          config.traceWriter,
          undefined,
          throttleQueue ? (info) => throttleQueue.push(info) : undefined,
          quotaObserver,
          rateLimitObserver,
          admissionGate,
        )
      : undefined,
  );
  const client = factory ? factory(clientOpts) : args.createClient(clientOpts);
  // In local-server mode, suppress the OAuth CLI-mimicry system-prefix
  // regardless of token shape: the shim is not Anthropic's billing surface
  // and should not receive Claude-Code identity headers in the system prompt.
  const systemPrefix = localMode ? null : buildSystemPrefix(authMode);

  let tokenRefresher: (() => Promise<Anthropic | null>) | undefined;
  // In local-server mode, never refresh the keychain OAuth token: a 401 from
  // the local shim must not cause the SDK to fetch and forward a real
  // Anthropic credential to a self-hosted endpoint. The placeholder token
  // path already prevents this on the initial request; this guard closes the
  // 401-retry hole.
  if (authMode === 'oauth' && !localMode) {
    tokenRefresher = async (): Promise<Anthropic | null> => {
      const freshToken = await refreshClaudeCodeOauthToken();
      if (!freshToken) return null;
      const opts = buildClientOptions(
        freshToken,
        'oauth',
        config.baseUrl,
        // Preserve throttle observability, the live-banner signal, quota
        // capture, and the admission gate across an OAuth account swap — the
        // rebuilt client must keep the same tracing-fetch wrapper wired to
        // the same `throttleQueue`, quota observer, rate-limit observer, and
        // admission gate. localMode is false in this branch (see the guard
        // above), so all observers are always defined here.
        makeTracingFetch(
          config.traceWriter,
          undefined,
          throttleQueue ? (info) => throttleQueue.push(info) : undefined,
          quotaObserver,
          rateLimitObserver,
          admissionGate,
        ),
      );
      return factory ? factory(opts) : args.createClient(opts);
    };
  }

  return {
    client,
    throttleQueue,
    systemPrefix,
    ...(tokenRefresher !== undefined ? { tokenRefresher } : {}),
  };
}
