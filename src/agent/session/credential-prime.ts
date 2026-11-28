/**
 * Session-start priming of the Claude Code login credential tier.
 *
 * Contract: CLI surfaces await `preloadClaudeKeychainOAuth` before a session
 * exists, so an expired stored access token is refreshed (and written back)
 * before the synchronous credential read at query time. A library session
 * built with `new AgentSession(...)` or `query()` has no such entry point; the
 * `ProviderRouter` awaits {@link primeSessionCredential} immediately before it
 * builds an inner provider, which is the first point where the session is
 * already asynchronous and before any provider request.
 *
 * The prime is skipped, with no credential store or network I/O, whenever the
 * stored login is not the credential the inner will use: a forked subagent
 * (inherits the parent's key), an explicit `config.apiKey`, a non-Anthropic
 * model, a local / `baseUrl` endpoint, a model slot carrying its own key or
 * endpoint, or an env credential (checked inside `preloadClaudeKeychainOAuth`).
 *
 * Concurrent primes and 401 retries share one in-flight refresh (see
 * `refreshClaudeCodeOauthTokenWithStatus`), so refresh-token rotation is never
 * raced; a stored token that is still valid causes no network request.
 *
 * @module agent/session/credential-prime
 */

import { providerForModel } from '../providers/index.js';
import { preloadClaudeKeychainOAuth } from '../auth/credential-resolver.js';
import { applySlotCredentials, type SlotCredentialTarget } from './slot-credentials.js';
import type { AgentConfig } from '../types/config-types.js';
import type { ClaudeLoginRefreshResult } from '../auth/claude-login-status.js';

// Session-scoped store for the last prime result, keyed by the AgentConfig
// object (unique per session). Avoids reading the process-global
// `lastClaudeLoginStatus()` — which is overwritten by every refresh attempt in
// a multi-session process — when building the "no credential" error.
const _primeResults = new WeakMap<AgentConfig, ClaudeLoginRefreshResult>();

/**
 * The result of the most recent {@link primeSessionCredential} call for
 * `config`, or `undefined` if the prime was skipped or not yet run. Never
 * touches the credential store; purely a session-local memo.
 */
export function getSessionPrimeLoginResult(
  config: AgentConfig,
): ClaudeLoginRefreshResult | undefined {
  return _primeResults.get(config);
}

/** Whether a session inner built for `model` would read the stored login. */
export function sessionNeedsStoredLogin(config: AgentConfig, model: string | undefined): boolean {
  if (config.isSubagentFork === true) return false;
  if (config.baseUrl !== undefined && config.baseUrl.length > 0) return false;
  const startupModel = typeof config.model === 'string' ? config.model : undefined;
  const effective = model ?? startupModel;
  if (effective === undefined) return false;
  if (providerForModel(effective) !== 'anthropic-direct') return false;
  // Mirrors ProviderRouter.resolveInner: config.apiKey is used only for the
  // family it was resolved for, so it rules the stored login out only when
  // the session started on the Anthropic family.
  const hasKey = config.apiKey !== undefined && config.apiKey.length > 0;
  if (hasKey && providerForModel(startupModel) === 'anthropic-direct') return false;
  // A model slot may carry its own key or endpoint; then the stored login is
  // not the credential in play. Scratch target: never mutate the session config.
  const probe: SlotCredentialTarget = { model: effective };
  applySlotCredentials(probe);
  if (probe.apiKey !== undefined || probe.baseUrl !== undefined) return false;
  return true;
}

/**
 * Refresh the stored login before the first provider request when the session
 * depends on it. Never throws; a failure leaves the store untouched and the
 * provider reports the recorded login status in its "no credential" error.
 *
 * Stores the refresh result in a session-scoped WeakMap keyed by `config` so
 * the provider can build a diagnostic error from THIS session's own prime
 * rather than from the process-global `lastClaudeLoginStatus()` (which is
 * overwritten by every other session's refresh in a multi-session process).
 */
export async function primeSessionCredential(config: AgentConfig, model: string | undefined): Promise<void> {
  if (!sessionNeedsStoredLogin(config, model)) return;
  try {
    const result = await preloadClaudeKeychainOAuth('anthropic-direct');
    if (result !== undefined) _primeResults.set(config, result);
  } catch {
    /* preload never throws; defensive so priming can never break a session */
  }
}
