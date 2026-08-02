import { displayWidth, truncateDisplayWidth } from '../../display.js';
import { palette } from '../../palette.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { styleForToolName } from '../../tool-category.js';
import {
  batchBadge,
  doneGlyph,
  formatDiffBlock,
  formatOutcome,
  sanitizeLabel,
  shortenPaths,
} from './tool-lane-format.js';
import type { ToolEntry } from './tool-lane-render.js';
import { clampLineToTerminal } from './tool-lane-render.js';

function groupedResultSuffix(
  entries: ToolEntry[],
  homeDir?: string,
): string {
  const completed = entries.filter((entry) => entry.result);
  const errors = completed.filter((entry) => entry.result!.isError);

  if (errors.length > 0) {
    const successCount = completed.length - errors.length;
    const lineCounts = completed
      .filter((entry) => !entry.result!.isError)
      .map((entry) => entry.result!.lineCount)
      .filter((count): count is number => count !== undefined);
    const totalLines = lineCounts.reduce((sum, count) => sum + count, 0);
    const parts: string[] = [];
    if (totalLines > 0) parts.push(`${totalLines} lines`);
    if (successCount > 0) parts.push(`${successCount} ok`);
    parts.push(palette.error(`${errors.length} error${errors.length > 1 ? 's' : ''}`));
    return palette.dim(' — ') + parts.join(palette.dim(', '));
  }

  const lineCounts = completed
    .map((entry) => entry.result?.lineCount)
    .filter((count): count is number => count !== undefined);
  if (lineCounts.length === completed.length && lineCounts.length > 0) {
    const allSame = lineCounts.every((count) => count === lineCounts[0]);
    if (allSame) return palette.dim(` — ${lineCounts[0]} lines each`);
    const total = lineCounts.reduce((sum, count) => sum + count, 0);
    return palette.dim(` — ${total} lines total`);
  }

  if (completed.length > 0) {
    const outcomes = completed.map((entry) =>
      formatOutcome(entry.result!, homeDir, 60, entry.toolName),
    );
    return palette.dim(' — ') + outcomes.join(palette.dim(', '));
  }

  return '';
}

/**
 * Render a root-level same-tool group as one terminal-width-safe row.
 *
 * Invariant: the result summary is more durable than the repeated argument
 * previews, so its display width is reserved before the joined targets are
 * truncated. A final clamp protects very narrow terminals where the fixed
 * tool identity plus summary cannot fit even after targets are removed.
 */
export function formatGroupedToolResults(
  toolName: string,
  entries: ToolEntry[],
  cols: number,
  homeDir?: string,
): string {
  const { color, glyph } = styleForToolName(toolName);
  const prefix =
    '  ' +
    color(glyph + ' ') +
    color.bold(toolName) +
    palette.dim(` ×${entries.length}`) +
    ' ';
  const suffix = groupedResultSuffix(entries, homeDir);
  const targets = entries
    .map((entry) => shortenPaths(sanitizeLabel(entry.toolInput)).trim())
    .join(', ');
  const targetWidth = Math.max(0, cols - displayWidth(prefix) - displayWidth(suffix));
  // Colorize BEFORE truncating: `palette.toolArg` is the same dim wrapper the
  // single-entry path applies via formatToolLine, so grouped args must not
  // render brighter than their ungrouped siblings. Wrapping first is safe
  // because truncateDisplayWidth tokenizes ANSI — escapes cost zero width, so
  // the reserved `targetWidth` budget is unaffected — and it re-closes both
  // the OSC 8 span and the SGR state when the cut lands inside them.
  const targetPreview = truncateDisplayWidth(palette.toolArg(targets), targetWidth);

  return clampLineToTerminal(prefix + targetPreview + suffix, cols);
}

export function renderGroupedRootTools(
  groups: Map<string, ToolEntry[]>,
  groupOrder: string[],
  homeDir?: string,
): string[] {
  const lines: string[] = [];
  // Read once per call: EVERY line this function emits is clamped to this
  // width so nothing soft-wraps to column 0 in scrollback (orphaning its
  // continuation past the indent). Mirrors the clamp on every other
  // emission path; see tool-lane-render-children.ts.
  //
  // Invariant: root entries arrive here with an UNBOUNDED prefix — the root
  // dispatch path (stream-renderer-orchestrator.ts) calls
  // addStartWithAgentContext without a maxWidth, unlike the subagent-child
  // path (stream-renderer-subagent.ts) which budgets it at cols - 14. So the
  // clamp here is the only thing standing between a 350-column bash command
  // and a wrapped scrollback row. The live overlay already clamps its
  // equivalents (tool-lane.ts); flush must not be the lone exception.
  const cols = getTerminalWidth();
  for (const toolName of groupOrder) {
    const entries = groups.get(toolName)!;
    if (entries.length === 1) {
      const e = entries[0]!;
      if (e.result) {
        // Plain clamp, not suffix-reservation as in the grouped path: for a
        // single entry the args ARE the identity and the outcome is the
        // expendable tail, which is exactly how the overlay clamps the same
        // row ("clamping should elide the outcome tail, not the leading
        // prefix that carries the tool identity" — tool-lane.test.ts).
        lines.push(clampLineToTerminal('  ' + e.prefix + palette.dim(' — ') + doneGlyph(e.result.isError, e.result.failureClass) + ' ' + formatOutcome(e.result, homeDir, 60, e.toolName) + batchBadge(e.result), cols));
        if (e.diff && !e.result.isError) {
          // Root-level scrollback diff: indent 4 spaces so it sits under
          // the outcome line (2 for the row indent, 2 more to clear the
          // tool-name column visually).
          for (const line of formatDiffBlock(e.diff, 'flush', '    ')) {
            lines.push(clampLineToTerminal(line, cols));
          }
        }
      } else {
        lines.push(clampLineToTerminal('  ' + e.prefix, cols));
      }
    } else {
      lines.push(formatGroupedToolResults(toolName, entries, cols, homeDir));
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
          // Order is load-bearing: sanitizeLabel BEFORE shortenPaths.
          // shortenPaths emits OSC 8 hyperlink escapes (the one sanctioned
          // escape producer in the lane); sanitizeLabel strips ALL ANSI, so
          // running it after would kill the link. Sanitizing first is
          // equally safe — toolInput is the injection surface, and it is
          // fully scrubbed before linkification adds our own escapes.
          const sanitized = sanitizeLabel(e.toolInput);
          const label = shortenPaths(sanitized).trim() || sanitized.trim();
          lines.push(clampLineToTerminal('    ' + palette.dim(`── ${label} ──`), cols));
        }
        for (const line of formatDiffBlock(e.diff!, 'flush', '    ')) {
          lines.push(clampLineToTerminal(line, cols));
        }
      }
    }
  }
  return lines;
}
