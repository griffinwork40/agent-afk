/**
 * Compact scrollback renderer for completed subagent blocks.
 *
 * When a subagent completes SUCCESSFULLY (no agent-level error), its full
 * tool-call tree is already visible in the live overlay while it runs.  Once
 * it finishes, writing every tool-call line to scrollback produces archaeology
 * that buries the summary.  This module replaces that full tree with a compact
 * two-line block:
 *
 *   ◉  → Agent(researcher) [worker]           ← head row (unchanged)
 *   │  ╰─ ✓ Done  3 tool calls · 2.1s         ← Done summary (last sibling)
 *
 * Error behaviour (approach A invariant: failures must never be hidden):
 *
 * 1. Agent-level error (agent result.isError === true, e.g. Ctrl-C / abort):
 *    The caller (formatAgentSummary / formatAgentChildren) detects this and
 *    falls back to renderFlushChildren (the full tree).  This function is not
 *    called in that case.
 *
 * 2. Child tool errors within a successful agent:
 *    Any tool child whose result.isError is true is emitted individually
 *    before the Done summary so the failure evidence is preserved.
 *
 * Only {@link renderCompactFlushChildren} is exported; it is called from
 * tool-lane-render-agent.ts in place of renderFlushChildren for the compact
 * path.
 */

import { displayWidth, stripAnsi } from '../../display.js';
import { palette } from '../../palette.js';
import {
  formatOutcome,
  doneGlyph,
} from './tool-lane-format.js';
import type { ToolEntry, Entry, Glyphs } from './tool-lane-render.js';
import {
  buildIndent,
  clampLineToTerminal,
  colorizeIndent,
  getGlyphs,
  toolLaneWidth,
  pushOutcomeLines,
} from './tool-lane-render.js';
import {
  addResultSummarySynthetic,
  assignConnectors,
} from './tool-lane-render-grouping.js';

/**
 * Collect all tool entries with an error result, recursively through child
 * maps.  Returns a flat list in BFS order so the earliest errors appear first.
 */
function collectErrorChildren(
  children: Entry[],
  childMap: Map<string, Entry[]>,
): ToolEntry[] {
  const errors: ToolEntry[] = [];
  const queue: Entry[] = [...children];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.kind !== 'tool') continue;
    if (item.result?.isError) {
      errors.push(item);
    }
    const grandchildren = childMap.get(item.toolUseId);
    if (grandchildren) queue.push(...grandchildren);
  }
  return errors;
}

/**
 * Render a compact scrollback block for a successfully-completed subagent.
 *
 * Emits:
 *   - One outcome row per errored tool child (in BFS order)
 *   - The `agentResultSummary` Done line as the last sibling
 *
 * All rows use the standard spine-connector protocol (assignConnectors) so
 * the topology is correct regardless of how many error children exist.
 *
 * Parameters mirror `renderFlushChildren` so the two can be swapped at the
 * call site without changing the surrounding code.
 */
export function renderCompactFlushChildren(
  children: Entry[],
  childMap: Map<string, Entry[]>,
  homeDir?: string,
  agentResultSummary?: string,
  cols: number = toolLaneWidth(),
  ancestorIsLast: readonly boolean[] = [],
  g: Readonly<Glyphs> = getGlyphs(),
): string[] {
  const indent = buildIndent(ancestorIsLast, g);
  const indentColored = colorizeIndent(indent, g, ancestorIsLast.length);
  const lines: string[] = [];

  // Collect only the tool children that errored (including nested ones).
  const errorChildren = collectErrorChildren(children, childMap);

  // Build the sibling list: error children as synthetic items + Done summary.
  // We represent error children as plain objects matching the sibling shape
  // expected by assignConnectors so we can reuse the connector logic.
  type ErrSibling = { kind: 'errChild'; entry: ToolEntry };
  type SumSibling = { kind: 'resultSummary'; summary: string };
  type Sibling = ErrSibling | SumSibling;

  const siblings: Sibling[] = errorChildren.map((e) => ({ kind: 'errChild', entry: e }));
  // addResultSummarySynthetic expects the generic sibling shape; replicate it
  // locally so we avoid a circular import and can keep the types simple.
  if (agentResultSummary) {
    siblings.push({ kind: 'resultSummary', summary: agentResultSummary });
  }

  if (siblings.length === 0) return lines;

  // Assign connectors manually (last gets lastConnector, all others get midConnector).
  for (let i = 0; i < siblings.length; i++) {
    const isLast = i === siblings.length - 1;
    const rawConnector = isLast ? g.lastConnector : g.midConnector;
    const connector = palette.dim(rawConnector);

    const sibling = siblings[i]!;
    if (sibling.kind === 'resultSummary') {
      // Done summary: emit verbatim (pre-styled by summaryWithBatchBadge).
      lines.push(clampLineToTerminal(indentColored + connector + sibling.summary, cols));
    } else {
      // Error child: emit the outcome row(s) for this tool entry.
      const entry = sibling.entry;
      if (entry.result) {
        const headLine =
          indentColored +
          connector +
          entry.prefix +
          palette.dim(' — ') +
          doneGlyph(entry.result.isError, entry.result.failureClass) +
          ' ';
        const continuationIndent =
          indentColored + (isLast ? g.spineClosed : palette.dim(g.spine)) + '  ';
        const outcomeBudget = Math.max(20, cols - displayWidth(stripAnsi(headLine)));
        const outcomeText = formatOutcome(entry.result, homeDir, outcomeBudget, entry.toolName);
        pushOutcomeLines(lines, headLine, outcomeText, continuationIndent, cols);
      }
    }
  }

  return lines;
}

// Re-export for convenience so consumers can import from one place.
export { addResultSummarySynthetic, assignConnectors };
