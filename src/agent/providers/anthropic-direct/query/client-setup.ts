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
  const clientOpts = buildClientOptions(
    args.token,
    authMode,
    config.baseUrl,
    // Observability: route SDK HTTP through a wrapper that (1) records
    // 429/503/529 throttling into the witness trace so the SDK's
    // otherwise-silent retry-after backoff is legible in `afk trace show`,
    // (2) pushes a live signal onto `throttleQueue` so the progress banner can
    // show the backoff as it happens, and (3) captures subscription-quota
    // headers into the quota cache for the status line. Skipped entirely in
    // local-shim mode (not Anthropic's billing surface). Note the wrapper is
    // installed whenever ANY of the three observers is live — a trace writer
    // is no longer required, since (3) must work with tracing disabled.
    !localMode
      ? makeTracingFetch(
          config.traceWriter,
          undefined,
          throttleQueue ? (info) => throttleQueue.push(info) : undefined,
          quotaObserver,
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
        // Preserve throttle observability, the live-banner signal AND quota
        // capture across an OAuth account swap — the rebuilt client must keep
        // the same tracing-fetch wrapper wired to the same `throttleQueue` and
        // the same quota observer. localMode is false in this branch (see the
        // guard above), so `quotaObserver` is always defined here and the
        // wrapper installs unconditionally — no trace-writer gate, matching
        // the primary install site above.
        makeTracingFetch(
          config.traceWriter,
          undefined,
          throttleQueue ? (info) => throttleQueue.push(info) : undefined,
          quotaObserver,
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
