/**
 * Collect `inlinePath` values from completed root tool entries.
 *
 * Extracted from `tool-lane.ts` to keep that file within the 350-code-line
 * ceiling (it was already baselined; this concern does not belong there).
 *
 * Called by `flushToolLaneToScrollback` (stream-renderer-orchestrator-emit.ts)
 * BEFORE `flushCompletedRoots()` removes entries, so the paths are captured
 * while they are still in the lane. See the TUI ordering constraint in
 * `src/cli/kitty-image.ts` for the rationale.
 *
 * @module cli/commands/interactive/tool-lane.inline-paths
 */

import type { Entry } from './tool-lane-render.js';

/**
 * Return the `inlinePath` strings from all currently-completed root tool
 * entries in `entries`. Read-only — does not mutate lane state.
 *
 * @param entries  The lane's live entry map (passed in to stay a pure function).
 * @param order    The lane's ordered entry ID array.
 * @returns Array of inlinePath strings (may be empty).
 */
export function collectCompletedRootInlinePaths(
  entries: ReadonlyMap<string, Entry>,
  order: readonly string[],
): string[] {
  const paths: string[] = [];
  for (const id of order) {
    const entry = entries.get(id);
    if (!entry || entry.kind !== 'tool') continue;
    if (entry.agentContext) continue;        // not a root
    if (entry.result === undefined) continue; // still in-flight
    const p = entry.result.inlinePath;
    if (p) paths.push(p);
  }
  return paths;
}
