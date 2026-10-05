/**
 * Human-readable label for whichever Anthropic credential tier is active.
 *
 * Walks the same precedence chain as `loadAnthropicCredential` and returns
 * the name of the first tier that resolves, so the `afk login` skip-message
 * tells the user *where* their credential came from.
 *
 * Returns a generic fallback when no tier matches (should not happen if
 * called after confirming a credential exists, but defensive).
 */

import { env } from '../config/env.js';
import { loadClaudeCodeOauthToken } from '../agent/auth/keychain.js';
import { hasProcessLocalRefreshedToken } from '../agent/auth/credential-resolver.js';

/**
 * Describe which Anthropic credential source is active, in the same
 * precedence order as `loadAnthropicCredential`:
 *   1. ANTHROPIC_API_KEY env
 *   2. CLAUDE_CODE_OAUTH_TOKEN env
 *   3. macOS Keychain / ~/.claude/.credentials.json (Claude Code login)
 *   4. Process-local refreshed token (write-back fallback)
 *
 * Invariant: the live store (tier 3) outranks the process-local cache (tier 4),
 * matching `loadAnthropicCredential` (see its Invariant block, #2469). The cache
 * is populated on every startup preload, so checking it first would label
 * almost every Claude Code login as "session refresh" and disagree with the
 * token the loader actually returns.
 */
export function describeCredentialSource(): string {
  switch (credentialSourceId()) {
    case 'ANTHROPIC_API_KEY': return 'ANTHROPIC_API_KEY';
    case 'CLAUDE_CODE_OAUTH_TOKEN': return 'CLAUDE_CODE_OAUTH_TOKEN';
    case 'claude-code-keychain': return 'Claude Code login (keychain)';
    // Tier 4: the store yielded nothing, so the loader is using the token
    // refreshed this process whose write-back failed.
    case 'claude-code-session-refresh': return 'Claude Code login (session refresh)';
    default: return 'existing credential';
  }
}

/** Stable machine-readable id for the active Anthropic credential tier. */
export type CredentialSourceId =
  | 'ANTHROPIC_API_KEY'
  | 'CLAUDE_CODE_OAUTH_TOKEN'
  | 'claude-code-keychain'
  | 'claude-code-session-refresh';

/**
 * Same precedence walk as `describeCredentialSource`, returning a stable enum
 * for JSON consumers (`afk status --format json`). `null` when no tier resolves.
 */
export function credentialSourceId(): CredentialSourceId | null {
  if (env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN';
  if (loadClaudeCodeOauthToken()) return 'claude-code-keychain';
  if (hasProcessLocalRefreshedToken()) return 'claude-code-session-refresh';
  return null;
}
