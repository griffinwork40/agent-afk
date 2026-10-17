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
 * Error text for a 401 that arrives after a tool already ran in the turn: the
 * token was refreshed from disk, but the turn is not replayed (replaying would
 * re-execute its tools). Exported for tests.
 */
export const MID_TURN_REFRESH_MESSAGE =
  'ChatGPT-OAuth token expired mid-turn after tools had already run. A fresh token was ' +
  'loaded from ~/.codex/auth.json and will be used from the next turn; this turn was not ' +
  'replayed to avoid re-running its tools.';

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
 *   - `auth.source === 'chatgpt-oauth'` + no 401: pass through unchanged, each
 *     event forwarded as it arrives (never buffered — liveness consumers such
 *     as the subagent idle watchdog depend on it).
 *   - `auth.source === 'chatgpt-oauth'` + 401 + different fresh token on disk:
 *     rebuild client; if no tool has run this turn, roll back the duplicate
 *     user turn from `priorTurns`, then run `makeNewAttempt()` exactly once and
 *     yield those events. If a tool already ran, do not replay — emit
 *     {@link MID_TURN_REFRESH_MESSAGE} (the next turn uses the fresh token).
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

  // Invariant: events are FORWARDED AS THEY ARRIVE — never buffered for the
  // turn. Downstream liveness consumers (the subagent idle watchdog in
  // subagent/idle-watchdog.ts, the TUI, Telegram streaming) observe nothing a
  // provider holds back, so the original whole-turn buffer here starved the
  // watchdog for the entire turn and killed every busy gpt-* subscription
  // child at exactly its idle window with `last event: none`.
  //
  // Consequence for the 401 replay: re-running the turn is only safe while no
  // tool has been dispatched. A 401 is an HTTP status, so in practice it lands
  // at the connection phase of the FIRST model request, before any output —
  // the common case replays exactly as before. A 401 after a tool already ran
  // must NOT replay the turn (that would re-execute side-effecting tools); the
  // client is still rebuilt so the NEXT turn uses the fresh token.

  // Snapshot priorTurns length BEFORE the first attempt so we can roll back
  // the user turn that pushUserTurn appends inside runTurnInner.
  const priorTurnsLenBefore = ctx.priorTurns.length;

  let detected401 = false;
  let toolDispatched = false;

  for await (const event of firstAttempt) {
    if (event.type === 'error' && is401(event.error)) {
      // 401 detected. Don't emit it yet — try to refresh first.
      detected401 = true;
      break;
    }
    if (event.type === 'tool.use.start') toolDispatched = true;
    yield event;
    // Any other error is terminal for the turn — already forwarded above.
    if (event.type === 'error') return;
  }

  // No 401 encountered: every event was already forwarded.
  if (!detected401) return;

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
    // Rebuild the underlying OpenAI client with the new token so this turn (if
    // replayable) and all future turns use it. Also updates opts.auth in place.
    ctx.rebuildClient(freshAuth);

    if (toolDispatched) {
      // Not replay-safe (see the Invariant above): surface the interruption.
      yield { type: 'error', error: new Error(MID_TURN_REFRESH_MESSAGE) };
      return;
    }

    // Roll back the user turn that runTurnInner pushed during the failed
    // attempt. The retry call to makeNewAttempt() will re-push it.
    ctx.priorTurns.splice(priorTurnsLenBefore);
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

  yield { type: 'error', error: new Error(diagMessage) };
}
