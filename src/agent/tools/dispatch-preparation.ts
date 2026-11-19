/** Shared model-intent and credential preparation for agent and compose forks. */
import { providerForModel } from '../providers/index.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import {
  resolveChildModel,
  type ResolveChildModelOpts,
  type ResolvedChildModel,
} from '../subagent/resolve-child-model.js';
import { applyParentCredentialFallback } from './child-credential.js';
import { resolveMaxNestingDepth } from './nesting.js';

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
  // SYNC: this exhaustive check must list every tier defined in ResolveChildModelOpts.
  // If a new tier is added to ResolveChildModelOpts, add it here too.
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

/**
 * Second shared pre-fork stage (#4042 Stage 3): resolve the effective
 * `maxDepth` for a child dispatch, applying the env-var default when the
 * caller's context does not carry an explicit cap.
 *
 * Both the agent-tool path (`subagent-executor.execute-once.ts`) and the
 * compose path (`compose-executor.preflight.ts`) previously inlined the
 * identical expression `ctx.maxDepth ?? resolveMaxNestingDepth()`. Extracting
 * it here means a future change to the resolution logic (e.g. a new env var or
 * a per-provider override) only needs to land in one place.
 *
 * Precondition: `ctxMaxDepth` is the value already stored on the executor
 * context (may be `undefined` for contexts constructed without an explicit
 * cap). Returns the env-var default when `ctxMaxDepth` is `undefined`.
 */
export function resolveChildMaxDepth(ctxMaxDepth: number | undefined): number {
  return ctxMaxDepth ?? resolveMaxNestingDepth();
}

/**
 * Caller-supplied root overrides from an agent or compose dispatch input.
 * All three fields are optional; a field being absent is distinct from it
 * being present with an empty array (`exactOptionalPropertyTypes` care).
 */
export interface RootOverrideInput {
  /** Working-directory override. When present, forwarded verbatim as `AgentConfig.cwd`. */
  cwd?: string;
  /** Write-root pins. When present, forwarded verbatim as `AgentConfig.writeRoots`. */
  writeRoots?: string[];
  /**
   * Additive extra read roots. Forwarded as `AgentConfig.extraReadRoots` (the ADDITIVE
   * field — the fork composes with its inherited read scope rather than replacing it).
   * Named `readRoots` on both caller inputs; renamed here to signal the forwarding
   * intent and prevent accidental confusion with `AgentConfig.readRoots` (the
   * PINNING field used by `afk farm`).
   */
  readRoots?: string[];
}

// Contract: applyRootOverrides is the single assembly point for a child's
// read/write scope. Any future change — validation, normalization, audit
// logging — belongs here so both callers pick it up automatically.
//
// The returned object uses exactOptionalPropertyTypes-compatible conditional
// spreads: absent input fields produce absent output fields (not
// undefined-valued keys), preserving the "key absent vs key present with
// undefined" distinction required by AgentConfig.
//
// Callers (both security-adjacent — they shape the child's filesystem access):
//   - buildBaseChildConfig in subagent/child-config.helpers.ts (agent-tool path)
//   - buildComposeDagNode in compose-executor.node-build.ts (compose path)
//
// Parity invariant: the returned object must be strictly identical for the
// same input regardless of which caller invokes it. Tests in
// dispatch-preparation.test.ts assert this for absent fields, explicitly
// empty arrays, and additive read roots.
export function applyRootOverrides(
  input: RootOverrideInput,
): { cwd?: string; writeRoots?: string[]; extraReadRoots?: string[] } {
  return {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.writeRoots !== undefined ? { writeRoots: input.writeRoots } : {}),
    ...(input.readRoots !== undefined ? { extraReadRoots: input.readRoots } : {}),
  };
}
