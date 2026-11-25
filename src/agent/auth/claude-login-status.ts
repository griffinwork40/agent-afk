/**
 * Why the stored Claude Code login did or did not yield a usable token, and
 * the operator-facing explanation for each case.
 *
 * Kept apart from `keychain.ts` so the provider layer can read the last
 * observed status when it builds its "no credential" error without importing
 * the credential store reader. Carries no token material: the status and the
 * messages are safe to log and to show.
 *
 * @module agent/auth/claude-login-status
 */

/**
 *   - `valid` / `refreshed`: a usable access token was produced.
 *   - `no-login`: no Claude Code login record in the store.
 *   - `no-token`: a login record exists but holds no access or refresh token.
 *   - `expired-no-refresh`: the access token is expired and there is no
 *     refresh token to renew it with.
 *   - `refresh-failed`: the token exchange with the refresh token failed.
 */
export type ClaudeLoginStatus =
  | 'valid'
  | 'refreshed'
  | 'no-login'
  | 'no-token'
  | 'expired-no-refresh'
  | 'refresh-failed';

/** Result of a refresh attempt against the stored Claude Code login. */
export interface ClaudeLoginRefreshResult {
  token?: string;
  status: ClaudeLoginStatus;
}

// Process-wide: the store is shared by every session in the process, so the
// last observation of it is too. Overwritten by every refresh attempt.
let lastStatus: ClaudeLoginStatus | undefined;

/** Record the outcome of the most recent refresh attempt. */
export function recordClaudeLoginStatus(status: ClaudeLoginStatus): void {
  lastStatus = status;
}

/** The outcome of the most recent refresh attempt in this process, if any. */
export function lastClaudeLoginStatus(): ClaudeLoginStatus | undefined {
  return lastStatus;
}

/** @internal Reset for isolated tests. */
export function _resetClaudeLoginStatus(): void {
  lastStatus = undefined;
}

const SIGN_IN_HINT =
  'Run `claude login` to sign in again, or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, or pass config.apiKey.';

/**
 * Operator-facing explanation of a status that yielded no token, or
 * `undefined` for a status that did. Never includes token material.
 */
export function describeClaudeLoginStatus(status: ClaudeLoginStatus | undefined): string | undefined {
  switch (status) {
    case 'no-login':
      return `No Claude Code login was found in the credential store. ${SIGN_IN_HINT}`;
    case 'no-token':
      return `The stored Claude Code login has no usable token (the record is empty). ${SIGN_IN_HINT}`;
    case 'expired-no-refresh':
      return `The stored Claude Code login token is expired and there is no refresh token to renew it. ${SIGN_IN_HINT}`;
    case 'refresh-failed':
      return `The stored Claude Code login token is expired and could not be refreshed. ${SIGN_IN_HINT}`;
    default:
      return undefined;
  }
}
