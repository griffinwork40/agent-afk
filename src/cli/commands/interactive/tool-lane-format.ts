import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import { env } from '../../../config/env.js';
import { palette } from '../../palette.js';
import { fileHyperlink, hyperlinksEnabled } from '../../hyperlink.js';
import { categorizeTool } from '../../tool-category.js';
import { sanitizeLabel, sanitizeTextParagraph } from './tool-lane-format-sanitize.js';

// Re-export the split modules' public surface so external callers keep
// importing the whole tool-lane formatting API from './tool-lane-format.js'.
// Split modules: -sanitize (LLM-string scrubbers, leaf), -args (tool-line +
// argument summarization), -diff (diff rendering, standalone).
export { sanitizeLabel, sanitizeTextParagraph };
export {
  shortenPaths,
  summarizeToolArgs,
  bracketPairAwareTruncate,
  formatToolLine,
} from './tool-lane-format-args.js';
export {
  MAX_OVERLAY_DIFF_LINES,
  FLUSH_DIFF_LINES_DEFAULT,
  formatDiffBlock,
} from './tool-lane-format-diff.js';

export const DONE_GLYPH = palette.success('✓');
export const ERROR_GLYPH = palette.error('✗');

export function doneGlyph(isError: boolean | undefined): string {
  return isError ? ERROR_GLYPH : DONE_GLYPH;
}

export const MAX_VISIBLE_CHILDREN = 3;

/**
 * Sibling-grouping thresholds. When ≥N siblings of the same tool name
 * appear under one parent, render them as a single grouped row
 * (`Agent(skill-review) ×5 — 3/5 done`) instead of consuming N slots
 * of the visible-children budget. The threshold differs by tool class:
 *
 * - Dispatch tools (`Agent`, `skill`, `compose`): threshold 2.
 *   The most common "model says I'm dispatching N, tree shows 1" failure
 *   is a parallel wave of exactly 2–5 agents; aggressive grouping here
 *   makes parallelism legible at a glance.
 * - Leaf tools (`bash`, `read_file`, `grep`, …): threshold 3.
 *   A burst of 2 read_file calls is normal narrative and worth showing
 *   individually; 3+ is repetitive enough to collapse.
 */
export const GROUP_THRESHOLD_DISPATCH = 2;
export const GROUP_THRESHOLD_LEAF = 3;

export function inProgressVerb(toolName: string): string {
  switch (categorizeTool(toolName)) {
    case 'read': return 'Reading…';
    case 'write': return 'Writing…';
    case 'web': return 'Fetching…';
    case 'shell': return 'Running…';
    default: return 'Running…';
  }
}

/**
 * Pick the right noun for an outcome line based on the tool's category.
 * Grep returns matches, glob returns paths, everything else returns lines.
 * Singular when count === 1, plural otherwise.
 */
function outcomeNoun(toolName: string | undefined, count: number): string {
  if (!toolName) return count === 1 ? 'line' : 'lines';
  // grep / glob report search results, not file size
  if (toolName === 'grep' || toolName === 'Grep') {
    return count === 1 ? 'match' : 'matches';
  }
  if (toolName === 'glob' || toolName === 'Glob') {
    return count === 1 ? 'path' : 'paths';
  }
  return count === 1 ? 'line' : 'lines';
}

export function formatOutcome(
  chunk: ToolResultChunk,
  homeDir?: string,
  maxPreview = 60,
  toolName?: string,
): string {
  const resultColor = chunk.isError ? palette.error : palette.dim;
  const effectiveHomeDir = homeDir ?? env.HOME ?? '___NOHOME___';

  // Handler-supplied display string wins over every other branch. The tool
  // handler is the only place that knows what its `content` JSON means; if
  // it provided a short, human-readable line, render it verbatim. Skipped
  // on error so the user sees the actual error text instead of a stale
  // success-shape summary the handler may have set before failing.
  if (chunk.display !== undefined && !chunk.isError) {
    return resultColor(chunk.display);
  }

  if (chunk.persistedPath) {
    const displayPath = chunk.persistedPath.startsWith(effectiveHomeDir)
      ? '~' + chunk.persistedPath.slice(effectiveHomeDir.length)
      : chunk.persistedPath;
    // OSC 8 hyperlink: keep the compact `~/…` display text but link to the
    // full absolute path so the saved file is Cmd+clickable in supporting
    // terminals. fileHyperlink percent-encodes the URI; zero display width
    // so layout is unchanged. Color wrapping the link is safe — SGR and
    // OSC 8 sequences nest independently.
    const linked = hyperlinksEnabled()
      ? fileHyperlink(displayPath, chunk.persistedPath)
      : displayPath;
    return resultColor(`saved → ${linked}`);
  }
  if (chunk.lineCount !== undefined && chunk.lineCount > 1) {
    return resultColor(`${chunk.lineCount} ${outcomeNoun(toolName, chunk.lineCount)}`);
  }
  const preview = chunk.content.length > maxPreview
    ? chunk.content.slice(0, maxPreview - 3) + '…'
    : chunk.content;
  // sanitizeLabel is the right sanitizer for outcome previews: chunk.content
  // is LLM-controlled and can embed BEL (rings the terminal bell), backspace,
  // DEL, CSI/OSC sequences, or bare CR (repositions the cursor). The earlier
  // shape — sanitizePrefixString(stripAnsi(...)) — only scrubbed ESC-prefixed
  // sequences plus \r\n, letting every other C0 byte through to the terminal.
  // Outcome lines are single-line contexts so trim + multi-space collapse
  // (sanitizeLabel's full shape) are the correct semantics.
  return resultColor(sanitizeLabel(preview));
}

/**
 * Concurrency-batch badge for a root tool row: ` ∥i/N` (dim) when the call ran
 * in a parallel wave of N>1 calls dispatched together, else `''`.
 *
 * Sourced from the dispatcher's authoritative post-partition batch (via
 * `ToolResultChunk.batchIndex`/`.batchSize`), so it is collision-incapable: it
 * can only appear on a call that genuinely shared a batch, never on a
 * back-to-back sequential dispatch. Every concurrency-unsafe tool (bash,
 * write_file, …) is its own singleton batch (batchSize=1) and is never badged.
 * This is the one signal that tells a parallel wave apart from sequential
 * dispatch once both have committed to append-only scrollback — where they are
 * otherwise visually identical (a done ◉ row followed by an in-flight ◉ row).
 * The `∥` (U+2225 PARALLEL TO) reads as "ran in parallel"; `i/N` is the 1-based
 * position within the wave.
 */
export function batchBadge(chunk: ToolResultChunk | undefined): string {
  if (
    !chunk ||
    typeof chunk.batchSize !== 'number' ||
    typeof chunk.batchIndex !== 'number' ||
    chunk.batchSize <= 1
  ) {
    return '';
  }
  return palette.dim(` ∥${chunk.batchIndex}/${chunk.batchSize}`);
}

/**
 * Format tool output as a two-line block (emitted together so both render
 * reliably). When `toolPrefix` is present the first line shows the tool
 * call; the second shows the outcome with a `⎿` connector.
 */
export function formatToolResultLine(
  chunk: ToolResultChunk,
  toolPrefix?: string,
  homeDir?: string,
  toolName?: string,
): string {
  const outcome = formatOutcome(chunk, homeDir, 80, toolName);

  if (toolPrefix) {
    return '  ' + toolPrefix + '\n  ⎿  ' + outcome;
  }
  return '  ⎿  ' + outcome;
}
