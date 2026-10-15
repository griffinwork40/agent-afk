/**
 * Parallel dispatch ratio computation — extracted from derive.ts to keep that
 * file within the 350-LOC limit. See derive.ts for the full design note.
 *
 * A "parallel turn" is any assistant turn that emitted more than one
 * deduplicated tool call (i.e. the model returned multiple tool_use blocks
 * in one response). The `dedupeToolEvents` pass must have already run on
 * each turn's events before calling this function.
 *
 * Design note: we count tool calls AT THE TURN LEVEL (using `turns` directly)
 * rather than re-grouping the flattened `allEvents` list. This preserves the
 * natural grouping the sidecar writer already recorded — each `TurnRecord`
 * corresponds to exactly one assistant response, so multiple toolEvents entries
 * in one turn = the model issued multiple tool_use blocks simultaneously.
 *
 * `ratio` is null when there are no tool calls to measure (avoids 0/0).
 */

import type { ParallelDispatchStats, ToolEventInput } from './schema.js';
import { dedupeToolEvents } from './derive.js';

export function computeParallelDispatch(
  turns: Array<{ toolEvents?: ToolEventInput[] }>,
): ParallelDispatchStats {
  let totalToolCalls = 0;
  let parallelToolCalls = 0;
  let parallelTurns = 0;
  let toolTurns = 0;

  for (const turn of turns) {
    const deduped = dedupeToolEvents(turn.toolEvents ?? []);
    const count = deduped.length;
    if (count === 0) continue;

    toolTurns += 1;
    totalToolCalls += count;

    if (count > 1) {
      parallelTurns += 1;
      parallelToolCalls += count;
    }
  }

  const ratio = totalToolCalls > 0 ? parallelToolCalls / totalToolCalls : null;

  return {
    total_tool_calls: totalToolCalls,
    parallel_tool_calls: parallelToolCalls,
    parallel_turns: parallelTurns,
    tool_turns: toolTurns,
    ratio,
  };
}
