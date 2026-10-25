/**
 * Centralized child-model resolution for all subagent dispatch paths.
 *
 * Canonical precedence (highest wins):
 *   1. callSiteModel    — explicit `model` on the tool call / SKILL.md `model:`
 *   2. namedAgentModel   — agent-definition `model:` (agent-tool path only)
 *   3. defaultSubagentModel — session-level policy (`getDefaultSubagentModel`)
 *   4. defaultModel      — parent session model (safety net for compose/skill)
 *   5. 'sonnet'          — hardcoded floor (should be unreachable in production
 *                           when `defaultSubagentModel` is properly wired)
 *
 * Replaces the 8 inline `?? 'sonnet'` chains that had drifted: child-config.ts
 * omitted `defaultModel`, compose-executor/fork-dispatch included it, and the
 * skill paths used optional chaining. This function is the single source of
 * truth so precedence cannot drift again.
 *
 * @module agent/subagent/resolve-child-model
 */

export interface ResolveChildModelOpts {
  /** Explicit model from the tool call input or SKILL.md `model:` field. */
  callSiteModel?: string;
  /** Named-agent definition model (only for the `agent` tool path). */
  namedAgentModel?: string;
  /** Session-level default from `getDefaultSubagentModel()`. */
  defaultSubagentModel?: string;
  /** Parent session model — safety net before the hardcoded floor. */
  defaultModel?: string;
}

/**
 * Which tier of the precedence chain supplied the resolved model. Used by
 * the default-tier fallback: only 'default' and 'floor' are eligible for an
 * automatic retry on the parent model when the initial run fails with a
 * model-rejection error. Explicit choices ('callSite', 'namedAgent',
 * 'parent') must fail loudly so the operator's intent is respected.
 */
export type ChildModelSource = 'callSite' | 'namedAgent' | 'default' | 'parent' | 'floor';

export interface ResolvedChildModel {
  model: string;
  source: ChildModelSource;
}

/**
 * Resolve the effective child model for a subagent dispatch, returning both
 * the model string and the provenance tier that supplied it.
 *
 * Every dispatch path (`agent` tool, `compose`, skill fork, plugin fork,
 * inline skill) calls this instead of inlining its own fallback chain.
 */
export function resolveChildModel(opts: ResolveChildModelOpts): string;
/**
 * Overload with `{ withSource: true }` — returns the model string AND the
 * provenance tier. Use this overload when the caller needs to gate on whether
 * the model came from an explicit choice or the default tier.
 */
export function resolveChildModel(
  opts: ResolveChildModelOpts,
  extra: { withSource: true },
): ResolvedChildModel;
export function resolveChildModel(
  opts: ResolveChildModelOpts,
  extra?: { withSource: true },
): string | ResolvedChildModel {
  let model: string;
  let source: ChildModelSource;

  if (opts.callSiteModel !== undefined) {
    model = opts.callSiteModel;
    source = 'callSite';
  } else if (opts.namedAgentModel !== undefined) {
    model = opts.namedAgentModel;
    source = 'namedAgent';
  } else if (opts.defaultSubagentModel !== undefined) {
    model = opts.defaultSubagentModel;
    source = 'default';
  } else if (opts.defaultModel !== undefined) {
    model = opts.defaultModel;
    source = 'parent';
  } else {
    model = 'sonnet';
    source = 'floor';
  }

  return extra?.withSource ? { model, source } : model;
}

/**
 * Derive `ForkSubagentOptions.modelFallback` from a resolved child model.
 *
 * Contract: returns a fallback ONLY when the model came from the default tier
 * (`'default'` = AFK_DEFAULT_SUBAGENT_MODEL / defaultSubagentModel, or the
 * `'floor'` literal) and the parent model is known and different. Explicit
 * call-site, SKILL.md, named-agent, or parent-inherited choices never fall
 * back: the operator asked for that model, so a rejection must fail loudly.
 */
export function defaultTierModelFallback(
  resolved: ResolvedChildModel,
  parentModel: string | undefined,
): { model: string } | undefined {
  if (resolved.source !== 'default' && resolved.source !== 'floor') return undefined;
  if (parentModel === undefined || parentModel === '' || parentModel === resolved.model) return undefined;
  return { model: parentModel };
}
