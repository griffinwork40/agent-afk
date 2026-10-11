/**
 * Mid-session ChatGPT-OAuth token refresh for the openai-compatible provider.
 *
 * When a session authenticates via `auth.source === 'chatgpt-oauth'` and a
 * turn returns an HTTP 401, it almost certainly means the access token that was
 * loaded at session start has expired. `codex` (the Codex CLI) may have already
 * refreshed it on disk — AFK must NEVER refresh the token itself because
 * refresh tokens are single-use and `codex` owns the refresh cycle.
 *
 * This module wraps the per-turn generator with exactly ONE re-resolve attempt:
 *
 *   1. Detect a 401 `error` event in the turn stream.
 *   2. Call `resolveOpenAIAuth` again with the same `forceChatgptOAuth` flag.
 *   3. If the resolved token is DIFFERENT (a fresh token `codex` wrote), call
 *      `ctx.rebuildClient(newAuth)` to swap the underlying OpenAI client and
 *      update `opts.auth`. Then roll back the user turn that was pushed to
 *      `priorTurns` during the failed attempt and replay the turn once.
 *   4. If the token is the same, expired, or missing, surface the
 *      `formatAuthDiagnostic` message — "EXPIRED — re-run `codex`" — instead of
 *      the raw 401. No retry loop.
 *   5. Non-chatgpt-oauth sessions: 401 is passed through unchanged (no re-resolve,
 *      no retry — API-key auth cannot be hot-swapped).
 *
 * **`priorTurns` rollback**: `runTurnInner` calls `pushUserTurn` before the first
 * model request. When that request 401s, the user message is already appended to
 * `priorTurns`. Before the second attempt the wrapper pops the last entry from
 * `priorTurns` to prevent a duplicate; `runTurnInner` re-appends it for the retry.
 *
 * AFK is read-only: it reads `~/.codex/auth.json` but NEVER writes it.
 * Refresh stays entirely with the `codex` binary.
 *
 * See issue #3396.
 *
 * @module agent/providers/openai-compatible/query/token-refresh
 */

import type { ProviderEvent } from '../../../provider.js';
import type { OpenAIMessage } from '../messages.js';
import { getErrorStatus } from './retry.js';
import {
  resolveOpenAIAuth,
  formatAuthDiagnostic,
  type OpenAIAuthResolution,
  type AuthResolverDeps,
} from '../auth.js';

/**
 * Minimal context the refresh wrapper needs from the owning query.
 * Kept narrow so this module never imports the full query class (avoids cycles).
 */
export interface OAuthRefreshContext {
  /** The live auth resolution — read to determine source + current token. */
  readonly opts: { readonly auth: OpenAIAuthResolution; readonly config: { readonly forceChatgptOAuth?: boolean } };
  /**
   * Rebuild the OpenAI client with a new auth resolution and update
   * `opts.auth` so all subsequent turns see the refreshed token.
   * Called only when a fresh (different) valid token is found.
   */
  rebuildClient(newAuth: OpenAIAuthResolution): void;
  /**
   * The live conversation history. Used to roll back the user turn that
   * `pushUserTurn` appended during the failed first attempt, so the retry
   * does not produce a duplicate message.
   */
  readonly priorTurns: OpenAIMessage[];
}

/**
 * True when the error event carries an HTTP 401 status.
 * Uses the shared `getErrorStatus` extractor so it handles both the OpenAI SDK
 * `APIError.status` shape and plain `{ status: number }` records from tests.
 */
export function is401(err: unknown): boolean {
  return getErrorStatus(err) === 401;
}

/**
 * Wrap a per-turn async generator with a single ChatGPT-OAuth token-refresh
 * retry on 401.
 *
 * Behaviour:
 *   - `auth.source !== 'chatgpt-oauth'`: pass through every event unchanged.
 *   - `auth.source === 'chatgpt-oauth'` + no 401: pass through unchanged.
 *   - `auth.source === 'chatgpt-oauth'` + 401 + different fresh token on disk:
 *     rebuild client, roll back the duplicate user turn from `priorTurns`, then
 *     run `makeNewAttempt()` exactly once and yield those events.
 *   - `auth.source === 'chatgpt-oauth'` + 401 + same/expired/missing token:
 *     replace the raw-401 error event with the diagnostic message.
 *
 * @param ctx            - Live query context (read `opts.auth`, call `rebuildClient`).
 * @param firstAttempt   - The turn generator from the first (pre-refresh) attempt.
 * @param makeNewAttempt - Factory that re-creates the turn generator after a
 *   client rebuild; called at most once. Must NOT re-push the user turn
 *   (the wrapper handles priorTurns rollback before calling this).
 * @param authDeps       - Env + fs injection point forwarded to `resolveOpenAIAuth`.
 *   Tests pass a hermetic stub here to prevent reading real host credentials.
 */
export async function* wrapTurnWithOAuthRefresh(
  ctx: OAuthRefreshContext,
  firstAttempt: AsyncGenerator<ProviderEvent>,
  makeNewAttempt: () => AsyncGenerator<ProviderEvent>,
  authDeps: AuthResolverDeps = {},
): AsyncGenerator<ProviderEvent> {
  // Non-OAuth sessions: pass through without any refresh logic.
  if (ctx.opts.auth.source !== 'chatgpt-oauth') {
    yield* firstAttempt;
    return;
  }

  // Snapshot priorTurns length BEFORE the first attempt so we can roll back
  // the user turn that pushUserTurn appends inside runTurnInner.
  const priorTurnsLenBefore = ctx.priorTurns.length;

  // Invariant: `runTurnInner` emits no events before the first model request
  // returns — session.init and any synthetic pre-turn events are yielded only
  // after the request is in flight.  This means `preTurnEvents` is empty when
  // a 401 fires on the very first request, so replaying it on retry is safe:
  // no duplicate session.init or tool events are emitted.  If that ordering
  // ever changes, the replay below must be audited for idempotence.
  const preTurnEvents: ProviderEvent[] = [];
  let detected401 = false;

  for await (const event of firstAttempt) {
    if (event.type === 'error' && is401(event.error)) {
      // 401 detected. Don't emit it yet — try to refresh first.
      detected401 = true;
      break;
    }
    // Non-401 errors: flush buffered events and re-emit unchanged.
    if (event.type === 'error') {
      for (const e of preTurnEvents) yield e;
      yield event;
      return;
    }
    preTurnEvents.push(event);
  }

  // No 401 encountered: flush the buffered events (turn completed normally).
  if (!detected401) {
    for (const e of preTurnEvents) yield e;
    return;
  }

  // 401 detected — attempt a token refresh (read-only: AFK never writes auth).
  const currentKey = ctx.opts.auth.apiKey;
  const forceChatgptOAuth = ctx.opts.config.forceChatgptOAuth ?? false;
  const freshAuth = resolveOpenAIAuth(undefined, authDeps, forceChatgptOAuth);

  // Conditions under which we retry: the fresh resolution is a valid chatgpt-oauth
  // token that is DIFFERENT from the one that just 401'd.
  const hasNewToken =
    freshAuth.source === 'chatgpt-oauth' &&
    freshAuth.apiKey !== null &&
    freshAuth.apiKey !== currentKey;

  if (hasNewToken) {
    // Rebuild the underlying OpenAI client with the new token so this turn and
    // all future turns use it. This also updates opts.auth in place.
    ctx.rebuildClient(freshAuth);

    // Roll back the user turn that runTurnInner pushed during the failed
    // attempt. The retry call to makeNewAttempt() will re-push it.
    ctx.priorTurns.splice(priorTurnsLenBefore);

    // Replay any buffered non-error events from the first attempt (e.g.
    // session.init), then run the second attempt with the fresh client.
    for (const e of preTurnEvents) yield e;
    yield* makeNewAttempt();
    return;
  }

  // No usable fresh token — surface the human-readable diagnostic instead of
  // the raw 401. Always emit the expired-token diagnostic regardless of whether
  // the disk still holds the same (now-401'd) token or an already-expired one:
  // if the token was accepted by re-resolve but is the same key that just 401'd,
  // it is effectively expired; the user's next step is the same — re-run `codex`.
  const diagAuth: OpenAIAuthResolution =
    freshAuth.source === 'chatgpt-oauth-expired'
      ? freshAuth
      : { ...ctx.opts.auth, source: 'chatgpt-oauth-expired' };

  const diagMessage = formatAuthDiagnostic(diagAuth);

  for (const e of preTurnEvents) yield e;
  yield { type: 'error', error: new Error(diagMessage) };
}
