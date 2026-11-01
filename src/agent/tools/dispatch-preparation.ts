/** Shared model-intent and credential preparation for agent and compose forks. */
import { providerForModel } from '../providers/index.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import {
  resolveChildModel,
  type ResolveChildModelOpts,
} from '../subagent/resolve-child-model.js';
import { applyParentCredentialFallback } from './child-credential.js';

/**
 * Compose must not even invoke a credential resolver for OpenAI nodes. The
 * agent path historically invokes it (including caller-owned side effects),
 * then discards the result. Neither path forwards that key in the fork config;
 * the OpenAI provider resolves its own credential. Keep the difference explicit.
 */
export type DispatchCredentialPolicy = 'skip-openai-resolution' | 'resolve-then-omit-openai';

export interface DispatchModelPreparationInput {
  /** Unresolved precedence tiers, not a flattened model string. */
  modelIntent: ResolveChildModelOpts;
  credentialPolicy: DispatchCredentialPolicy;
  resolveApiKeyForModel?: (model: string) => string | undefined;
  parentApiKey?: string;
}

/**
 * First shared pre-fork stage (#4042). Resolve model intent before credentials
 * so provider routing, source provenance, and the cross-provider anti-leak
 * decision always agree. Tool/provider construction remains caller-specific:
 * compose is a leaf; agent forks may have scoped nested executors.
 */
export function prepareDispatchModel(input: DispatchModelPreparationInput) {
  const resolved = resolveChildModel(input.modelIntent, { withSource: true });
  const isOpenAI = providerForModel(resolved.model) === 'openai-compatible';
  if (isOpenAI && input.credentialPolicy === 'skip-openai-resolution') {
    return { ...resolved, isOpenAI, apiKey: undefined };
  }

  const freshKey = input.resolveApiKeyForModel
    ? input.resolveApiKeyForModel(resolved.model)
    : resolveCredentialForModel(resolved.model);
  const apiKey = applyParentCredentialFallback({
    childModel: resolved.model,
    resolved: freshKey,
    parentApiKey: input.parentApiKey,
  });
  // Even a misconfigured resolver returning an Anthropic key cannot leak it
  // into an OpenAI config. Do not rely on the parent-fallback helper for this:
  // it intentionally preserves a nonempty resolved key unchanged.
  return { ...resolved, isOpenAI, apiKey: isOpenAI ? undefined : apiKey };
}
