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
 * Resolve the effective child model for a subagent dispatch.
 *
 * Every dispatch path (`agent` tool, `compose`, skill fork, plugin fork,
 * inline skill) calls this instead of inlining its own fallback chain.
 */
export function resolveChildModel(opts: ResolveChildModelOpts): string {
  return (
    opts.callSiteModel
    ?? opts.namedAgentModel
    ?? opts.defaultSubagentModel
    ?? opts.defaultModel
    ?? 'sonnet'
  );
}
