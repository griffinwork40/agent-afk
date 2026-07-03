import { providerForModel, type BundledProviderName } from '../providers/index.js';

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
 * parent-credential fallback against the cross-provider leak — in BOTH
 * directions.
 *
 * The manager's historical fallback was `config.apiKey || parentApiKey` —
 * provider-blind. That reintroduced the parent's credential even when an
 * upstream executor (subagent-executor.ts, skill-executor.ts,
 * compose-executor.ts) had *deliberately* cleared `apiKey` for a
 * cross-provider child, shipping the wrong credential to a foreign endpoint:
 * an Anthropic `sk-ant-…` token to an OpenAI-shaped endpoint, or an OpenAI
 * `sk-proj-…` token to `api.anthropic.com` (401 at best; both auth resolvers
 * treat an explicit config key as Tier-1 — see openai-compatible/auth.ts).
 *
 * The source of truth is `parentProvider`, which the manager derives ONCE
 * (in its constructor) from the parent model via `providerForModel` — not a
 * guess from the key's shape, which is format-fragile (legacy bare `sk-`
 * OpenAI keys have no distinguishing prefix). Rules (in order):
 *   - explicit non-empty `configApiKey` → returned unchanged (caller wins).
 *   - no `parentApiKey` → `undefined` (nothing to inherit).
 *   - provider-identity gate: inherit `parentApiKey` IFF the child's provider
 *     (`providerForModel(childModel)`) equals the parent's provider; otherwise
 *     `undefined` (never cross the provider boundary). This preserves
 *     legitimate same-provider inheritance — including non-`sk-ant` keys used
 *     by local Anthropic-shim setups, since those route to `anthropic-direct`.
 *
 * Fallback when `parentProvider` is absent (legacy callers / direct
 * construction that didn't pass `parentModel`): infer `'anthropic-direct'`
 * from an `sk-ant-` key so the forward guard still holds, and otherwise leave
 * it unknowable and inherit — exactly the pre-`parentModel` behavior, so no
 * existing caller regresses. The reverse-direction protection activates only
 * where the manager supplies `parentProvider`.
 *
 * Invariant: `parentProvider` and `providerForModel(childModel)` are both
 * canonical provider names (`'anthropic-direct'` / `'openai-compatible'`), so
 * the `===` comparison is exact — the manager only ever supplies a
 * `providerForModel()` result.
 */
export function applyManagerApiKeyFallback(args: {
  childModel: string | undefined;
  configApiKey: string | undefined;
  parentApiKey: string | undefined;
  parentProvider?: BundledProviderName | undefined;
}): string | undefined {
  const { childModel, configApiKey, parentApiKey, parentProvider } = args;
  if (configApiKey !== undefined && configApiKey.length > 0) return configApiKey;
  if (parentApiKey === undefined) return undefined;
  const effectiveParent =
    parentProvider ?? (isAnthropicCredential(parentApiKey) ? 'anthropic-direct' : undefined);
  if (effectiveParent === undefined) return parentApiKey;
  return providerForModel(childModel) === effectiveParent ? parentApiKey : undefined;
}
