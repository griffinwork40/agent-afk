import { providerForModel } from '../providers/index.js';

/**
 * True iff `key` is an Anthropic-shaped credential — an API key
 * (`sk-ant-api…`) or a Claude Code OAuth token (`sk-ant-oat…`). Both share the
 * `sk-ant-` prefix. Used to gate the fork-time parent-credential fallback so an
 * OpenAI-shaped parent credential never reaches an Anthropic child.
 */
export function isAnthropicCredential(key: string | undefined): key is string {
  return typeof key === 'string' && key.startsWith('sk-ant-');
}

/**
 * Contract: resolve the effective credential for a dispatched child
 * (`agent` / `skill` fork), applying a fork-time fallback to the parent's
 * bootstrap-captured credential.
 *
 * Per-model resolution (PR #640) is primary: `resolved` is keyed to the
 * child's own provider, which preserves the cross-provider anti-leak
 * invariant. But for Anthropic children that resolver routes through the
 * *sync* keychain reader (`loadClaudeCodeOauthToken`), which returns
 * `undefined` the instant the Claude Code OAuth token is past `expiresAt` —
 * with no refresh attempt. That starves the child at the provider pre-flight
 * (`AnthropicDirectProvider: requires config.apiKey`) even though the parent,
 * holding a bootstrap-captured token, keeps working via its request-time 401
 * refresher (`anthropic-direct/index.ts`).
 *
 * Fallback: when `resolved` is empty for a *same-provider* (Anthropic) child,
 * reuse `parentApiKey` IFF it is Anthropic-shaped. The child then has a token
 * to attempt with, and its own 401 refresher self-heals — instead of dying
 * before any request. This restores the pre-#640 token-inheritance safety net
 * for the keychain-auth path without re-introducing the cross-provider leak
 * #640 fixed:
 *
 *   - non-empty `resolved`  → returned unchanged (no fallback needed).
 *   - OpenAI-routed child   → returns `resolved` unchanged (never inherits an
 *     Anthropic parent credential; the OpenAI auth resolver handles it).
 *   - Anthropic parent cred → forwarded only when Anthropic-shaped, else the
 *     child is left credential-less (correct: no Anthropic credential exists).
 */
export function applyParentCredentialFallback(args: {
  childModel: string;
  resolved: string | undefined;
  parentApiKey: string | undefined;
}): string | undefined {
  const { childModel, resolved, parentApiKey } = args;
  if (resolved !== undefined && resolved.length > 0) return resolved;
  if (providerForModel(childModel) === 'openai-compatible') return resolved;
  return isAnthropicCredential(parentApiKey) ? parentApiKey : resolved;
}
