/**
 * Skill allowlist gate (#3442) for {@link SkillExecutor.execute}.
 *
 * Contract: exact string equality on the requested skill name. There is no
 * namespace inference in either direction: `plugin:name`, `user:name`,
 * `project:name` (and `imported:<bin>:name`) must be listed verbatim, and a
 * bare `name` authorizes only a request for exactly `name`. An `undefined`
 * allowlist means no gate; an empty list refuses every skill.
 */
import type { ToolResult } from '../types.js';

/**
 * Return an `isError` refusal naming the allowed skills when `name` is not on
 * `allowlist`; `undefined` when the call may proceed.
 */
export function skillAllowlistRefusal(
  allowlist: readonly string[] | undefined,
  name: string,
): ToolResult | undefined {
  if (allowlist === undefined || allowlist.includes(name)) return undefined;
  const allowed = allowlist.length > 0 ? allowlist.join(', ') : '(none)';
  return {
    content: `Skill "${name}" is not allowed in this session. Allowed skills: ${allowed}`,
    isError: true,
  };
}
