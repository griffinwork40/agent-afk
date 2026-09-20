/**
 * Shell-string escaping utility.
 *
 * Previously duplicated verbatim across six sites:
 *   - `agent/session/subagent-output-capture.ts`
 *   - `agent/session/subagent-prompt-capture.ts`
 *   - `cli/input/clipboard-image.ts`
 *   - `cli/terminal-spawn/spawners.ts`
 *   - `browser/agent-browser/actions.ts`
 *   - `service/systemd/unit.ts` (partial — unit.ts also escapes \n, \r, %)
 *
 * All consolidated here so callers import one utility instead of repeating the
 * backslash + double-quote escape inline.
 *
 * @module utils/shell-escape
 */

/**
 * Escape a string for safe embedding inside a double-quoted shell or
 * AppleScript literal: backslashes are doubled and double-quotes are
 * backslash-escaped.
 *
 * The result is the INTERIOR of a double-quoted string — wrap it yourself
 * if you need the surrounding quotes (e.g. `'"' + escapeShellString(s) + '"'`).
 * Some callers (clipboard-image.ts, subagent-output/prompt-capture.ts) add
 * the surrounding quotes; spawners.ts and actions.ts use the raw result inside
 * an already-quoted context.
 */
export function escapeShellString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
