import type { ToolEntry } from './tool-lane-render.js';
import { palette } from '../../palette.js';
import { NESTING_TOOLS } from '../../tool-category.js';
import {
  GROUP_THRESHOLD_DISPATCH,
  GROUP_THRESHOLD_LEAF,
  formatToolLine,
} from './tool-lane-format.js';
import type { Glyphs } from './tool-lane-render.js';
import { getGlyphs } from './tool-lane-render.js';
import {
  addOverflowSynthetic,
  formatCategoricalOverflow,
  type OverflowSibling,
} from './tool-lane-render-grouping-overflow.js';

interface GroupedSibling {
  kind: 'group';
  toolName: string;
  /** Shared toolInput for dispatch groups; empty string otherwise. */
  label: string;
  entries: ToolEntry[];
}

/**
 * Synthetic result-summary placeholder produced by {@link addResultSummarySynthetic}.
 *
 * Invariant: `summary` is PRE-STYLED by its sole feeder `summaryWithBatchBadge`
 * (dim base + self-dimmed `∥i/N` batch badge). Render sites emit it verbatim and
 * MUST NOT re-wrap it in `palette.dim()` — re-dimming nests the badge's own dim.
 */
interface ResultSummarySibling {
  kind: 'resultSummary';
  summary: string;
}

type RenderableSibling = ToolEntry | GroupedSibling | OverflowSibling | ResultSummarySibling;

/** A {@link RenderableSibling} decorated with its tree connector string. */
interface ConnectedSibling {
  sibling: RenderableSibling;
  /** `g.lastConnector` for the last sibling; `g.midConnector` for all prior. */
  connector: string;
}

/**
 * Pure, total function. Assigns tree connectors to an ordered list of
 * renderable siblings using the supplied glyph set.
 *
 * Contract (property-tested under Unicode default):
 * - For any non-empty list: exactly one item has connector `g.lastConnector` and it is last.
 * - For any list: no item after a `g.lastConnector` item exists.
 * - Empty input → empty output (no crash).
 *
 * Constraint: `g.midConnector` and `g.lastConnector` are the runtime
 * tree-connector strings. The overflow ellipsis and result-summary
 * synthetic siblings obey the same rule — they are added to the list BEFORE
 * this function runs so the last-child rule applies naturally.
 */
function assignConnectors(
  siblings: RenderableSibling[],
  g: Readonly<Glyphs> = getGlyphs(),
): ConnectedSibling[] {
  return siblings.map((sibling, i) => ({
    sibling,
    connector: i === siblings.length - 1 ? g.lastConnector : g.midConnector,
  }));
}

/**
 * If `agentResultSummary` is non-null/non-undefined, appends a synthetic
 * {@link ResultSummarySibling} to `siblings`. Otherwise returns `siblings`
 * unchanged.
 *
 * KEY INVARIANT: this helper is called BEFORE `assignConnectors` so the
 * result-summary line is treated as the last sibling and receives the `'└ '`
 * connector. Previously the summary was appended AFTER `renderFlushChildren`
 * returned with a hardcoded `'⎿'` glyph — that was Bug #5.
 */
function addResultSummarySynthetic(
  siblings: RenderableSibling[],
  agentResultSummary: string | undefined,
): RenderableSibling[] {
  if (!agentResultSummary) return siblings;
  return [...siblings, { kind: 'resultSummary', summary: agentResultSummary }];
}

/**
 * Collapse runs of same-tool siblings into a single grouped row when their
 * count meets the per-category threshold. Preserves the first-occurrence
 * position of each group so the visual order matches the dispatch order.
 *
 * - Dispatch tools collapse at GROUP_THRESHOLD_DISPATCH = 2.
 * - Leaf tools collapse at GROUP_THRESHOLD_LEAF = 3.
 *
 * Below threshold: emit each entry individually so 2 leaf bashes still
 * render as two separate lines (normal narrative).
 */
function groupSiblings(toolChildren: ToolEntry[]): Array<ToolEntry | GroupedSibling> {
  if (toolChildren.length === 0) return [];

  const buckets = new Map<string, ToolEntry[]>();
  for (const child of toolChildren) {
    const key = getGroupKey(child);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(child);
  }

  const out: Array<ToolEntry | GroupedSibling> = [];
  const emittedKeys = new Set<string>();
  for (const child of toolChildren) {
    const key = getGroupKey(child);
    const bucket = buckets.get(key)!;
    if (bucket.length >= thresholdForTool(child.toolName)) {
      if (!emittedKeys.has(key)) {
        out.push({
          kind: 'group',
          toolName: child.toolName,
          label: NESTING_TOOLS.has(child.toolName) ? child.toolInput : '',
          entries: bucket,
        });
        emittedKeys.add(key);
      }
    } else {
      out.push(child);
    }
  }
  return out;
}

/**
 * Render a grouped-sibling row:
 *   `<glyph> <Name><label>  ×<N> — <status>`
 *
 * Status flips between `N running`, `K/N done`, `N done`, or
 * `K ok, M errors` based on per-entry result presence.
 */
function formatGroupedSibling(group: GroupedSibling): string {
  const total = group.entries.length;
  const completed = group.entries.filter((e) => e.result);
  const errors = completed.filter((e) => e.result!.isError);
  const done = completed.length;

  let status: string;
  if (errors.length > 0) {
    const ok = done - errors.length;
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} ok`);
    parts.push(`${errors.length} error${errors.length === 1 ? '' : 's'}`);
    status = parts.join(', ');
  } else if (done === total) {
    status = `${total} done`;
  } else if (done === 0) {
    status = `${total} running`;
  } else {
    status = `${done}/${total} done`;
  }

  const prefix = formatToolLine(group.toolName + group.label);
  return prefix + palette.dim(` ×${total} — ${status}`);
}

/**
 * Grouping key for sibling collapse. For dispatch-class tools (Agent /
 * skill / compose) we include the toolInput so a wave of
 * `Agent(skill-review)` doesn't merge with `Agent(critic-paranoid)` —
 * the label IS the dispatch's identity. For leaf tools (bash, read_file,
 * etc.) we group by toolName only; a burst of N `bash` calls is the same
 * class of work regardless of their per-invocation command strings.
 */
function getGroupKey(entry: ToolEntry): string {
  if (NESTING_TOOLS.has(entry.toolName)) {
    return entry.toolName + '::' + entry.toolInput;
  }
  return entry.toolName;
}

function thresholdForTool(toolName: string): number {
  return NESTING_TOOLS.has(toolName)
    ? GROUP_THRESHOLD_DISPATCH
    : GROUP_THRESHOLD_LEAF;
}

export {
  assignConnectors,
  addOverflowSynthetic,
  addResultSummarySynthetic,
  groupSiblings,
  formatGroupedSibling,
  formatCategoricalOverflow,
  type GroupedSibling,
  type OverflowSibling,
  type ResultSummarySibling,
  type RenderableSibling,
  type ConnectedSibling,
};
