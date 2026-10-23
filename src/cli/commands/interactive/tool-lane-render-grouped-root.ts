import { displayWidth, stripAnsi, truncateDisplayWidth } from '../../display.js';
import { palette } from '../../palette.js';
import { styleForToolName } from '../../tool-category.js';
import {
  batchBadge,
  doneGlyph,
  formatDiffBlock,
  formatOutcome,
  isBenignFailure,
  sanitizeLabel,
  shortenPaths,
} from './tool-lane-format.js';
import type { ToolEntry } from './tool-lane-render.js';
import { clampLineToTerminal, toolLaneWidth } from './tool-lane-render.js';
import { outcomeTailWidth, pushOutcomeRows } from './tool-lane-outcome-rows.js';
import { isBashToolName, styleBashCommand } from './tool-lane-format-bash.js';

function groupedResultSuffix(
  entries: ToolEntry[],
  cols: number,
  homeDir?: string,
): string {
  const completed = entries.filter((entry) => entry.result);
  const errors = completed.filter((entry) => entry.result!.isError);
  const blocked = errors.filter((entry) => isBenignFailure(entry.result!.failureClass));
  const faults = errors.filter((entry) => !isBenignFailure(entry.result!.failureClass));

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
    if (faults.length > 0) {
      parts.push(palette.error(`${faults.length} error${faults.length > 1 ? 's' : ''}`));
    }
    if (blocked.length > 0) parts.push(palette.warning(`${blocked.length} blocked`));
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
    // tailWidth governs continuation-row budgets; continuation lines are then
    // stripped below since grouped summaries are always single-line.
    const tailWidth = outcomeTailWidth(cols, '   ');
    const outcomes = completed.map((entry) =>
      formatOutcome(entry.result!, homeDir, 60, entry.toolName, tailWidth).replace(/\n[\s\S]*/u, '…'),
    );
    return palette.dim(' — ') + outcomes.join(palette.dim(', '));
  }

  return '';
}

// C0/C1 control bytes EXCLUDING LF (\x0A). Used by styleGroupedTargets to
// sanitize bash toolInput while preserving the newline command separator that
// the bash lexer inside styleBashCommand needs to find command-word boundaries.
const CONTROL_EXCEPT_LF = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g;

/**
 * Style and join grouped target strings into a single display string capped at
 * `targetWidth` columns, stopping early once the budget is spent.
 *
 * Invariant: bash entries are styled BEFORE newline flattening (mirrors
 * tool-lane-format-args.ts:365-370). The order is:
 *   1. stripAnsi + strip C0/C1 except LF + trim  — remove injection surface
 *      while preserving the newline command separator the lexer needs; trim
 *      ensures the first command word lands at position 0 (lexer start pos)
 *   2. styleBashCommand                          — danger-chip + dim on correct words
 *   3. replace [\r\n]+ → ' '                    — flatten the now-styled string
 *   4. shortenPaths                              — path linkification
 * Non-bash entries use sanitizeLabel (which flattens LF) then shortenPaths,
 * matching pre-existing behaviour for non-bash grouped rows.
 */
function styleGroupedTargets(
  toolName: string,
  entries: ToolEntry[],
  targetWidth: number,
): string {
  const isBash = isBashToolName(toolName);
  const sep = palette.toolArg(', ');
  const sepWidth = displayWidth(sep);
  let result = '';
  let remaining = targetWidth;
  for (const entry of entries) {
    if (result !== '' && remaining <= 0) break;
    const raw = entry.toolInput;
    let styled: string;
    if (isBash) {
      // Step 1: strip ANSI and all C0/C1 control bytes except LF (\x0A),
      // then trim edge whitespace so the lexer sees the first command word
      // at position 0 (mirrors the single-entry path which trims before
      // passing to formatToolLine).
      const clean = stripAnsi(raw).replace(CONTROL_EXCEPT_LF, ' ').trim();
      // Step 2: linkify paths BEFORE SGR styling so collapseFsPaths regex
      // matches absolute-path command words unobstructed by escape sequences.
      // OSC 8 hyperlinks emitted here are opaque to the bash lexer (it treats
      // them as a single token) — see tool-lane-format-bash.ts lexer comment.
      const shortened = shortenPaths(clean);
      // Step 3: style with LF intact so lexer sees newline command separators
      const withStyle = styleBashCommand(shortened);
      // Step 4: flatten newlines on the now-styled string
      styled = withStyle.replace(/[\r\n]+/g, ' ');
    } else {
      styled = palette.toolArg(shortenPaths(sanitizeLabel(raw)).trim());
    }
    if (result === '') {
      result = styled;
      remaining -= displayWidth(styled);
    } else {
      result += sep + styled;
      remaining -= sepWidth + displayWidth(styled);
    }
  }
  return result;
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
    '   ' +
    color(glyph + ' ') +
    color.bold(toolName) +
    palette.dim(` ×${entries.length}`) +
    ' ';
  const suffix = groupedResultSuffix(entries, cols, homeDir);
  const targetWidth = Math.max(0, cols - displayWidth(prefix) - displayWidth(suffix));
  const styledTargets = styleGroupedTargets(toolName, entries, targetWidth);
  const targetPreview = truncateDisplayWidth(styledTargets, targetWidth);

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
  const cols = toolLaneWidth();
  for (const toolName of groupOrder) {
    const entries = groups.get(toolName)!;
    if (entries.length === 1) {
      const e = entries[0]!;
      if (e.result) {
        // pushOutcomeRows splits multi-line formatOutcome so continuation
        // lines carry '   ' (the same 3-space root indent) instead of a
        // bare inline join that would embed a raw \n into the row. This
        // mirrors the child-render and overlay paths — see
        // tool-lane-render-children.ts and tool-lane.ts.
        pushOutcomeRows(lines, {
          lead: '   ',
          label: e.prefix,
          sep: palette.dim(' — ') + doneGlyph(e.result.isError, e.result.failureClass) + ' ',
          suffix: batchBadge(e.result),
        }, e.result, { continuationIndent: '   ', cols, homeDir, toolName: e.toolName });
        if (e.diff && !e.result.isError) {
          // Root-level scrollback diff: indent 4 spaces so it sits under
          // the outcome line (3 for the row indent, 1 more to clear the
          // tool-name column visually).
          for (const line of formatDiffBlock(e.diff, 'flush', '    ')) {
            lines.push(clampLineToTerminal(line, cols));
          }
        }
      } else {
        lines.push(clampLineToTerminal('   ' + e.prefix, cols));
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
