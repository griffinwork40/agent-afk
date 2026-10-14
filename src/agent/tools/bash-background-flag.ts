/**
 * Single predicate for "this bash call starts a background process".
 *
 * Every read-only gate (read-only skills, plan mode, what-if episodes) and
 * the risk classifier must treat a `run_in_background` launch as mutating
 * regardless of the command text: the process outlives the call by up to
 * 24 h, so "the command looks read-only" is never sufficient. One leaf
 * module keeps those gates from drifting apart.
 *
 * @module agent/tools/bash-background-flag
 */

export function isBackgroundBashLaunch(toolName: string, input: unknown): boolean {
  return (
    toolName.toLowerCase() === 'bash' &&
    typeof input === 'object' &&
    input !== null &&
    (input as Record<string, unknown>)['run_in_background'] === true
  );
}
