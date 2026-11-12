/**
 * Human-readable label for whichever Anthropic credential tier is active.
 *
 * Provenance is a first-class output of the credential loader
 * (`resolveAnthropicCredential`, #4778): this module never re-walks the
 * precedence chain itself, so the label/id can never disagree with the token
 * the loader actually selected (the drift class behind #2469).
 */

import {
  resolveAnthropicCredential,
  type CredentialSourceId,
} from '../agent/auth/credential-resolver.js';

export type { CredentialSourceId };

/**
 * Describe an Anthropic credential source. When `source` is omitted, reads the
 * provenance from the loader result. Returns a generic fallback when no tier
 * resolves (should not happen if called after confirming a credential exists,
 * but defensive).
 */
export function describeCredentialSource(
  source: CredentialSourceId | null = credentialSourceId(),
): string {
  switch (source) {
    case 'ANTHROPIC_API_KEY': return 'ANTHROPIC_API_KEY';
    case 'CLAUDE_CODE_OAUTH_TOKEN': return 'CLAUDE_CODE_OAUTH_TOKEN';
    case 'claude-code-keychain': return 'Claude Code login (keychain)';
    // Tier 4: the store yielded nothing, so the loader is using the token
    // refreshed this process whose write-back failed.
    case 'claude-code-session-refresh': return 'Claude Code login (session refresh)';
    default: return 'existing credential';
  }
}

/**
 * Stable enum for the active Anthropic credential tier (`afk status --format
 * json`, session-meta sidecar, witness trace). A thin reader of the loader's
 * own `source` output. `null` when no tier resolves.
 */
export function credentialSourceId(): CredentialSourceId | null {
  return resolveAnthropicCredential()?.source ?? null;
}
