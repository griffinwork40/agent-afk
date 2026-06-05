import { palette } from '../../palette.js';
import { styleForToolName } from '../../tool-category.js';
import { getTerminalWidth } from '../../terminal-size.js';
import {
  MAX_VISIBLE_CHILDREN,
  formatOutcome,
  formatDiffBlock,
  doneGlyph,
  sanitizeLabel,
  shortenPaths,
} from './tool-lane-format.js';
import type { ToolEntry, Entry } from './tool-lane-render.js';
import { getGlyphs } from './tool-lane-render.js';
import { renderFlushChildren } from './tool-lane-render-children.js';

/**
 * Render an Agent (subagent) entry plus its tree of children as a scrollback
 * block.
 *
 * `extraDepth` shifts the entire block right by N additional spine columns
 * (2 cells per level — the same width as a depth-1 spine slot). Default 0
 * = root-level Agent rendering (one `◉ ` marker at col 0). Callers pass
 * `extraDepth > 0` when the Agent sits under a still-in-flight ancestor
 * (e.g. a `skill` parent that hasn't yet completed) so the committed
 * scrollback block visually aligns with the live overlay's nesting instead
 * of unparenting itself the moment it transitions to Done.
 *
 * Under the spine renderer, each unit of `extraDepth` becomes one live
 * `g.spine` slot prepended to every row of the rendered block — the
 * external ancestor's column continues through the descendant's lines so
 * the spine reads as one continuous topology even across commit boundaries.
 *
 * External constraint (pattern card: ordered sequences governed by
 * append-only scrollback): once a subagent's done-event commits its block to
 * scrollback, the indent of that block cannot be retroactively adjusted. The
 * depth MUST be resolved by the caller — by walking the `agentContext` chain
 * of surviving lane entries — at the moment of commit.
 */
function formatAgentSummary(
  agent: ToolEntry,
  children: Entry[],
  childMap: Map<string, Entry[]>,
  homeDir?: string,
  ancestorIsLast: readonly boolean[] = [],
): string {
  const g = getGlyphs();
  const toolChildren = children.filter((c): c is ToolEntry => c.kind === 'tool');
  const completed = toolChildren.filter((c) => c.result);
  const totalLines = completed.reduce((sum, c) => sum + (c.result!.lineCount ?? 0), 0);

  // Reads toolChildren.length — the tool-lane's own list of committed ToolEntry
  // children. Post-2c invariant: toolChildren.length === source.stats.toolUses
  // at flush time, because every tool_use_detail event both adds a ToolEntry and
  // increments source.stats.toolUses (both increment-only paths).
  const stats: string[] = [];
  if (toolChildren.length > MAX_VISIBLE_CHILDREN) {
    stats.push(`${toolChildren.length} tools`);
    if (totalLines > 0) stats.push(`${totalLines} lines`);
  }

  // Invariant: the HEAD row keeps every ancestor column OPEN; only DESCENDANT
  // rows close a last-child ancestor's column.
  //
  // The Agent's head row gets the `◉ ` marker (2 cells, same width as a spine
  // slot). `ancestorPrefix` draws one OPEN `g.spine` (`│ `) per live ancestor
  // — UNCONDITIONALLY, regardless of last-ness — so the head row's incoming
  // spine stays connected to its still-in-flight parent above (PR #642
  // floating-spine invariant: a committed ancestor header must never float
  // disconnected from its children). This matches the live overlay, where an
  // agent's OWN row is `│ ╰─ …` (parent column open via the active spine).
  //
  // DESCENDANT rows, by contrast, must CLOSE the column of any ancestor that
  // is currently the last sibling at its level — the overlay draws `╰─` there
  // and closes the column to `g.spineClosed` (`  `) below it. `ancestorIsLast`
  // (resolved by the caller at commit time via `ToolLane.ancestorIsLastOf`)
  // carries that per-column last-ness into `renderFlushChildren`. Pre-fix this
  // was an all-`false` vector (open `│` everywhere), so committed descendant
  // rows showed an open `│` at a column the overlay had closed — the visible
  // "severed spine" seam (col-0 `│` continuing below a last-child connector).
  //
  // Pattern card alignment: ordered-sequences governed by append-only
  // scrollback — both depth and last-ness must be resolved at commit time.
  const ancestorPrefix = palette.dim(g.spine.repeat(ancestorIsLast.length));
  const externalAncestors: readonly boolean[] = ancestorIsLast;

  const head = palette.dim(g.turnRoot);
  const agentLine = stats.length > 0
    ? ancestorPrefix + head + agent.prefix + palette.dim(' — ' + stats.join(' · '))
    : ancestorPrefix + head + agent.prefix;

  // Pass agentResultSummary into renderFlushChildren so it is added as a
  // synthetic sibling BEFORE assignConnectors runs — ensuring the Done line
  // receives the correct LAST connector (not a hardcoded '⎿', which was Bug #5).
  // Thread `g` so the head row and child rows share one glyph set. `cols` is
  // read here at the head so the recursive flush frame uses the same width.
  // `externalAncestors` extends the spine column-set leftward by `extraDepth`
  // so descendant rows align under the head row's ancestor spines.
  const childLines = renderFlushChildren(
    children,
    childMap,
    homeDir,
    agent.agentResultSummary,
    getTerminalWidth(),
    externalAncestors,
    g,
  );

  return [agentLine, ...childLines].join('\n');
}

/**
 * Emit only the single header line for a NESTING_TOOLS ancestor entry —
 * the spine-encoded head row — without any children, resultSummary, or
 * tree connectors below.
 *
 * Used by {@link ToolLane.flushSource} to eagerly anchor an ancestor's
 * frame header in append-only scrollback the moment its first child
 * subagent commits (done-event), so subsequent child completions and any
 * interleaved prose all land BELOW the ancestor's visual header instead
 * of visually floating above a deferred frame closer.
 *
 * Encoding constraint: this head row MUST match the head-row encoding in
 * {@link formatAgentSummary} (line 1: `ancestorPrefix + g.turnRoot +
 * agent.prefix`). Both functions may emit a head row for the SAME
 * ToolEntry across the lifetime of a session — flushSource emits it
 * eagerly via this function, then dispose-time flush() may emit it via
 * formatAgentSummary for an entry whose flushSource never ran. If the
 * two encodings diverge, the user sees a visible topology break: rows
 * committed by formatAgentHeader appear with naked space indent while
 * descendants below render with `│ │ ◉ ` spine columns, leaving the
 * outermost ancestor floating without a spine that connects to its
 * children.
 *
 * Width invariant matches formatAgentSummary: `g.spine` is 2 cells,
 * `g.turnRoot` is 2 cells, so the total head-row indent is
 * `2 * (ancestorIsLast.length + 1)` cells before `agent.prefix` — exactly the
 * same column position renderFlushChildren expects for its child rows.
 *
 * `ancestorIsLast` mirrors the same parameter contract as
 * {@link formatAgentSummary}: each element represents whether the corresponding
 * ancestor level was the last child at that depth. The HEAD row always keeps
 * all ancestor columns OPEN (rendered as `g.spine`) regardless of the values
 * in `ancestorIsLast` — callers pass an all-false vector for live ancestors.
 */
function formatAgentHeader(agent: ToolEntry, ancestorIsLast: readonly boolean[] = []): string {
  const g = getGlyphs();
  const ancestorPrefix = palette.dim(g.spine.repeat(ancestorIsLast.length));
  const head = palette.dim(g.turnRoot);
  return ancestorPrefix + head + agent.prefix;
}

/**
 * Emit only the children portion of an Agent/skill/compose frame — the
 * tree-connected child rows and optional `agentResultSummary` closer —
 * without the header line. Used by {@link ToolLane.flush} when an
 * ancestor entry's header was already emitted eagerly (via
 * {@link ToolLane.flushSource} / {@link formatAgentHeader}) so that
 * dispose-time flush can commit the frame closer without duplicating the
 * header that is already in scrollback.
 *
 * Callers must pass `ancestorIsLast` equal to the vector used when the header
 * was eagerly emitted so the tree connectors align with it. The header itself
 * (via {@link formatAgentHeader}) keeps its ancestor columns OPEN; these child
 * rows close any last-child ancestor column — see {@link formatAgentSummary}.
 */
function formatAgentChildren(
  agent: ToolEntry,
  children: Entry[],
  childMap: Map<string, Entry[]>,
  homeDir?: string,
  ancestorIsLast: readonly boolean[] = [],
): string[] {
  // Mirror formatAgentSummary's DESCENDANT-row encoding: thread the per-column
  // last-ness vector into renderFlushChildren so each ancestor column draws an
  // open `g.spine` (`│ `) when that ancestor is NOT its level's last sibling,
  // and a closed `g.spineClosed` (`  `) when it IS — matching the live overlay
  // (which closes a `╰─`'d ancestor's column below it). Pre-fix this was an
  // all-`false` vector (open `│` everywhere), diverging from the overlay on
  // committed scrollback descendant rows (the severed-spine seam). The header
  // row was emitted separately by formatAgentHeader with its columns OPEN, so
  // the eagerly-committed ancestor stays connected to its children (Bug B /
  // PR #642). `getGlyphs()` is read once so the block shares one glyph set.
  const g = getGlyphs();
  const externalAncestors: readonly boolean[] = ancestorIsLast;
  return renderFlushChildren(
    children,
    childMap,
    homeDir,
    agent.agentResultSummary,
    getTerminalWidth(),
    externalAncestors,
    g,
  );
}

function renderGroupedRootTools(
  groups: Map<string, ToolEntry[]>,
  groupOrder: string[],
  homeDir?: string,
): string[] {
  const lines: string[] = [];
  for (const toolName of groupOrder) {
    const entries = groups.get(toolName)!;
    if (entries.length === 1) {
      const e = entries[0]!;
      if (e.result) {
        lines.push('  ' + e.prefix + palette.dim(' — ') + doneGlyph(e.result.isError) + ' ' + formatOutcome(e.result, homeDir, 60, e.toolName));
        if (e.diff && !e.result.isError) {
          // Root-level scrollback diff: indent 4 spaces so it sits under
          // the outcome line (2 for the row indent, 2 more to clear the
          // tool-name column visually).
          for (const line of formatDiffBlock(e.diff, 'flush', '    ')) {
            lines.push(line);
          }
        }
      } else {
        lines.push('  ' + e.prefix);
      }
    } else {
      lines.push(formatGroupedToolResults(toolName, entries, homeDir));
      // Emit per-entry diff blocks under the grouped header. Each diff hangs
      // at the same 4-space indent as the single-entry path above, giving
      // the grouped case the same visual treatment as individual entries.
      // When multiple entries have diffs, emit a labeled `── filename ──`
      // separator before each diff block so the reader can attribute hunks
      // to specific files at a glance (e.g. write_file ×2 renders two diffs
      // with "── globals.css ──" / "── layout.tsx ──" labels).
      //
      // External constraint (presentation invariant): when N>1 grouped entries
      // each contribute a diff block, the blocks must be visually separated by
      // a labeled divider so a reader can attribute hunks to specific files.
      // Without the divider, two 62-line `write_file` diffs fuse into one
      // 124-line block in the rendered transcript with no file boundary
      // visible — see audit RC-3.
      // `sanitizeLabel` wraps the user-controlled toolInput to prevent
      // control-sequence injection into the dim separator line.
      const entriesWithDiffs = entries.filter((e) => e.diff && e.result && !e.result.isError);
      const needSeparators = entriesWithDiffs.length > 1;
      for (const e of entriesWithDiffs) {
        if (needSeparators) {
          const label = sanitizeLabel(shortenPaths(e.toolInput).trim() || e.toolInput.trim());
          lines.push('    ' + palette.dim(`── ${label} ──`));
        }
        for (const line of formatDiffBlock(e.diff!, 'flush', '    ')) {
          lines.push(line);
        }
      }
    }
  }
  return lines;
}

function formatGroupedToolResults(
  toolName: string,
  entries: ToolEntry[],
  homeDir?: string,
): string {
  const { color, glyph } = styleForToolName(toolName);
  const targets = entries.map((e) => sanitizeLabel(shortenPaths(e.toolInput).trim()));
  const header =
    color(glyph + ' ') +
    color.bold(toolName) +
    palette.dim(` ×${entries.length}`) +
    ' ' +
    palette.toolArg(targets.join(', '));

  const completed = entries.filter((e) => e.result);
  const errors = completed.filter((e) => e.result!.isError);

  if (errors.length > 0) {
    const successCount = completed.length - errors.length;
    const lineCounts = completed
      .filter((e) => !e.result!.isError)
      .map((e) => e.result!.lineCount)
      .filter((c): c is number => c !== undefined);
    const totalLines = lineCounts.reduce((a, b) => a + b, 0);
    const parts: string[] = [];
    if (totalLines > 0) parts.push(`${totalLines} lines`);
    if (successCount > 0) parts.push(`${successCount} ok`);
    parts.push(palette.error(`${errors.length} error${errors.length > 1 ? 's' : ''}`));
    return '  ' + header + palette.dim(' — ') + parts.join(palette.dim(', '));
  }

  const lineCounts = completed
    .map((e) => e.result?.lineCount)
    .filter((c): c is number => c !== undefined);
  if (lineCounts.length === completed.length && lineCounts.length > 0) {
    const allSame = lineCounts.every((c) => c === lineCounts[0]);
    if (allSame) {
      return '  ' + header + palette.dim(` — ${lineCounts[0]} lines each`);
    }
    const total = lineCounts.reduce((a, b) => a + b, 0);
    return '  ' + header + palette.dim(` — ${total} lines total`);
  }

  if (completed.length > 0) {
    const outcomes = completed.map((e) => formatOutcome(e.result!, homeDir, 60, e.toolName));
    return '  ' + header + palette.dim(' — ') + outcomes.join(palette.dim(', '));
  }

  return '  ' + header;
}

export {
  formatAgentSummary,
  formatAgentHeader,
  formatAgentChildren,
  renderGroupedRootTools,
  formatGroupedToolResults,
};
