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

/**
 * Describe which Anthropic credential source is active, in the same
 * precedence order as `loadAnthropicCredential`:
 *   1. ANTHROPIC_API_KEY env
 *   2. CLAUDE_CODE_OAUTH_TOKEN env
 *   3. Process-local refreshed token (indistinguishable from keychain here)
 *   4. macOS Keychain / ~/.claude/.credentials.json (Claude Code login)
 */
export function describeCredentialSource(): string {
  if (env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN';
  // Tiers 3+4 are both "Claude Code login" from the user's perspective.
  if (loadClaudeCodeOauthToken()) return 'Claude Code login (keychain)';
  return 'existing credential';
}
