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

/**
 * Contract: resolve the effective `apiKey` for a child forked by
 * `SubagentManager.forkSubagent`, guarding the manager-level
 * parent-credential fallback against the cross-provider leak.
 *
 * The manager's historical fallback was `config.apiKey || parentApiKey` —
 * provider-blind. That reintroduced the parent's credential even when an
 * upstream executor (subagent-executor.ts, skill-executor.ts,
 * compose-executor.ts) had *deliberately* cleared `apiKey` for an
 * OpenAI-routed child: an Anthropic `sk-ant-…` parent credential reached
 * the OpenAI-compatible provider, whose auth resolver treats any explicit
 * config key as Tier-1 (see openai-compatible/auth.ts) — shipping the
 * Anthropic token as a Bearer to an OpenAI-shaped endpoint (401 at best).
 *
 * Rules (in order):
 *   - explicit non-empty `configApiKey` → returned unchanged (caller wins).
 *   - OpenAI-routed child + Anthropic-shaped parent credential → `undefined`
 *     (never leak `sk-ant-…` across the provider boundary; the OpenAI auth
 *     resolver walks its own env / codex precedence cleanly).
 *   - otherwise → `parentApiKey` (preserves legitimate inheritance: an
 *     OpenAI-shaped key from an OpenAI-routed parent flows to OpenAI
 *     children; Anthropic children keep inheriting the parent credential,
 *     including non-`sk-ant` keys used by local Anthropic-shim setups).
 */
export function applyManagerApiKeyFallback(args: {
  childModel: string | undefined;
  configApiKey: string | undefined;
  parentApiKey: string | undefined;
}): string | undefined {
  const { childModel, configApiKey, parentApiKey } = args;
  if (configApiKey !== undefined && configApiKey.length > 0) return configApiKey;
  if (
    providerForModel(childModel) === 'openai-compatible' &&
    isAnthropicCredential(parentApiKey)
  ) {
    return undefined;
  }
  return parentApiKey;
}
