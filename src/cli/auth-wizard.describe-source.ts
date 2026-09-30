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
 *   3. Process-local refreshed token (keychain refresh succeeded but write-back failed)
 *   4. macOS Keychain / ~/.claude/.credentials.json (Claude Code login)
 *
 * Note: tier 3 (session-refresh) ranks above tier 4 (keychain) to match the
 * precedence in `loadAnthropicCredential`: `refreshedClaudeCodeOauthToken` is
 * checked before `loadClaudeCodeOauthToken()` there, so we mirror that order
 * here. The live keychain store outranks the process-local cache in the
 * loader, so when both are present the loader uses the keychain — but if a
 * refresh produced a token and the write-back to the store failed, the cache
 * is the only source of that token, and we want the label to reflect it
 * accurately rather than claiming "keychain".
 */
export function describeCredentialSource(): string {
  if (env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN';
  // Tier 3: token was refreshed this process but write-back to the persistent
  // store failed — the token is NOT in the keychain, so label it distinctly.
  if (hasProcessLocalRefreshedToken()) return 'Claude Code login (session refresh)';
  if (loadClaudeCodeOauthToken()) return 'Claude Code login (keychain)';
  return 'existing credential';
}
