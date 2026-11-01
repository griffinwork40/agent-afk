/** Shared model-intent and credential preparation for agent and compose forks. */
import { providerForModel } from '../providers/index.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import {
  resolveChildModel,
  type ResolveChildModelOpts,
  type ResolvedChildModel,
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

/** Result of {@link prepareDispatchModel}: resolved model with provenance and credential. */
export interface PrepareDispatchModelResult extends ResolvedChildModel {
  /** True when the resolved model routes through the OpenAI-compatible provider. */
  isOpenAI: boolean;
  /**
   * Resolved API key for Anthropic-family children; always `undefined` for
   * OpenAI children regardless of policy (the OpenAI provider self-resolves).
   */
  apiKey: string | undefined;
}

/**
 * First shared pre-fork stage (#4042). Resolve model intent before credentials
 * so provider routing, source provenance, and the cross-provider anti-leak
 * decision always agree. Tool/provider construction remains caller-specific:
 * compose is a leaf; agent forks may have scoped nested executors.
 *
 * Precondition: `modelIntent` must contain at least one non-undefined tier so
 * resolution does not silently fall to the hardcoded 'sonnet' floor. Pass
 * `defaultSubagentModel` or `defaultModel` when no explicit model is known.
 */
export function prepareDispatchModel(input: DispatchModelPreparationInput): PrepareDispatchModelResult {
  const { modelIntent } = input;
  if (
    modelIntent.callSiteModel === undefined &&
    modelIntent.namedAgentModel === undefined &&
    modelIntent.defaultSubagentModel === undefined &&
    modelIntent.defaultModel === undefined
  ) {
    throw new Error(
      'prepareDispatchModel: modelIntent has no resolvable tier — pass at least defaultSubagentModel or defaultModel to avoid a silent sonnet floor.',
    );
  }

  const resolved = resolveChildModel(modelIntent, { withSource: true });
  const isOpenAI = providerForModel(resolved.model) === 'openai-compatible';
  if (isOpenAI && input.credentialPolicy === 'skip-openai-resolution') {
    return { ...resolved, isOpenAI, apiKey: undefined };
  }

  // 'resolve-then-omit-openai': intentionally invoke the resolver even for
  // OpenAI children (preserving caller-owned side effects such as logging or
  // audit trails), then unconditionally discard the result. Do not short-circuit
  // this call — the discard below is the security gate, not the early exit above.
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
