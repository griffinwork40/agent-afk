/**
 * Public health check for the Anthropic credential an SDK session would use.
 *
 * @module agent/auth/anthropic-credential-check
 */

import { preloadClaudeKeychainOAuth, resolveAnthropicCredential, type CredentialSourceId } from './credential-resolver.js';
import { describeClaudeLoginStatus, lastClaudeLoginStatus } from './claude-login-status.js';

/** Outcome of {@link checkAnthropicCredential}. Never carries token material. */
export interface AnthropicCredentialStatus {
  ok: boolean;
  /** The tier that produced the credential, when `ok`. */
  source?: CredentialSourceId;
  /** Operator-facing explanation, when not `ok`. */
  detail?: string;
}

/**
 * Prime and check the Anthropic credential without starting a session.
 *
 * Same precedence and priming as an `AgentSession` on the Anthropic provider:
 * `ANTHROPIC_API_KEY`, then `CLAUDE_CODE_OAUTH_TOKEN`, then the stored Claude
 * Code login, refreshing an expired stored access token with its refresh
 * token (and writing it back) when no env credential is set. Never throws.
 */
export async function checkAnthropicCredential(): Promise<AnthropicCredentialStatus> {
  await preloadClaudeKeychainOAuth('anthropic-direct');
  const cred = resolveAnthropicCredential();
  if (cred) return { ok: true, source: cred.source };
  return {
    ok: false,
    detail:
      describeClaudeLoginStatus(lastClaudeLoginStatus()) ??
      'No Anthropic credential found. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or run `claude login`.',
  };
}
