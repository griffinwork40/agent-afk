/**
 * Skill-tool max-nesting-depth refusal message.
 *
 * Extracted as a pure, dependency-free module so two consumers share one
 * source of truth:
 *
 *   1. {@link SkillExecutor.execute} returns it when a `skill` call lands at or
 *      beyond the nesting-depth limit — the runtime guardrail.
 *   2. `afk improve eval-run` asserts the recovery hint is present without
 *      importing the heavy skill-executor module graph or firing its routing
 *      telemetry as a side effect.
 *
 * History: the refusal originally inlined a bare "not available at depth N"
 * string. PR #80 expanded it with an actionable recovery hint (work inline
 * instead of delegating) after telemetry showed sessions stalling at the depth
 * wall. Keeping the hint here — beside the message it belongs to — makes its
 * presence a checkable contract rather than a string literal buried in a
 * thousand-line executor.
 *
 * @module agent/tools/skill-depth-message
 */

/**
 * The actionable recovery clause appended to the skill max-depth refusal.
 * Exported so the eval-run validator can assert its presence directly.
 */
export const SKILL_MAX_DEPTH_RECOVERY_HINT =
  'You are too deeply nested to delegate further — perform the work inline with your own tools instead of calling skill/agent/compose.';

/**
 * Build the full refusal message returned by the `skill` tool when invoked at
 * or beyond {@link DEFAULT_MAX_NESTING_DEPTH}. Always carries
 * {@link SKILL_MAX_DEPTH_RECOVERY_HINT}.
 */
export function buildSkillMaxDepthRefusal(depth: number, maxDepth: number): string {
  return `Skill tool not available at nesting depth ${depth} (max ${maxDepth}). ${SKILL_MAX_DEPTH_RECOVERY_HINT}`;
}
