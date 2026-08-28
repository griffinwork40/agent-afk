/**
 * CompactDiffView — standalone inline diff viewer component.
 *
 * A pure function (spec → string) that renders a colored unified-diff block
 * with a stat header, hunk bodies, truncation footer, and optional box
 * framing. Fully decoupled from ToolLane internals — callable from any
 * surface (Telegram, JSON, slash commands, unit tests).
 *
 * Color: palette only, never raw chalk.
 * Box framing: drawBox from ./box.js.
 * LOC ceiling: 350 (enforced by audit:filesize:check).
 */

import { palette } from '../palette.js';
import { stripAnsi } from '../display.js';
import { drawBox } from './box.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A contiguous block of diff lines with its @@ header. */
export interface DiffHunk {
  /** e.g. "@@ -10,3 +10,5 @@" */
  header: string;
  /** Raw diff lines with +/- prefixes, e.g. "+ added line", "- removed", "  context" */
  lines: string[];
}

/** Input spec for {@link compactDiffView}. */
export interface CompactDiffSpec {
  /** File path to display in the stat header. */
  filePath: string;
  /** Hunks to render. */
  hunks: DiffHunk[];
  /** Addition and removal counts shown in the stat header. */
  stats: { added: number; removed: number };
  /**
   * Maximum number of diff body lines to render before truncating.
   * Hunk @@ headers are NOT counted against this cap.
   * Default: 20.
   */
  maxLines?: number;
  /**
   * Collapsed mode: render only the stat header, no hunk body.
   * Useful for preview chips and notification surfaces.
   */
  collapsed?: boolean;
  /**
   * Terminal width passed through to drawBox for the hunk body frame.
   * Default: 80.
   */
  width?: number;
}

// ---------------------------------------------------------------------------
// Control-char scrubber (mirrors tool-lane-format-diff.ts)
// ---------------------------------------------------------------------------

/**
 * Strips bare C0 controls (except TAB and LF) plus DEL and C1 range so that
 * adversarial file content cannot ring the bell, reposition the cursor, or
 * inject CSI sequences through the diff render path.
 */
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

function sanitizeDiffText(raw: string): string {
  return stripAnsi(raw).replace(CONTROL_CHAR_RE, '');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Color a single diff line string (first char is the prefix: +, -, or space).
 * Returns the styled string. Lines that don't start with + or - are treated
 * as context lines and dimmed.
 */
function colorLine(line: string): string {
  const safe = sanitizeDiffText(line);
  if (safe.startsWith('+')) return palette.diffAdd(safe);
  if (safe.startsWith('-')) return palette.diffRemove(safe);
  return palette.dim(safe);
}

/**
 * Build the one-line stat header:
 *   `src/foo.ts  +12 -5`
 */
function buildStatHeader(spec: CompactDiffSpec): string {
  const fp = palette.fileRef(spec.filePath);
  const added = palette.diffAdd(`+${spec.stats.added}`);
  const removed = palette.diffRemove(`-${spec.stats.removed}`);
  return `${fp}  ${added} ${removed}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a compact diff view as a multi-line string ready for terminal output.
 *
 * @param spec - The diff specification.
 * @returns A styled, multi-line string. Ends without a trailing newline.
 *
 * @example
 * ```ts
 * const out = compactDiffView({
 *   filePath: 'src/foo.ts',
 *   hunks: [{ header: '@@ -1,3 +1,4 @@', lines: ['+  added', '  ctx'] }],
 *   stats: { added: 1, removed: 0 },
 * });
 * process.stdout.write(out + '\n');
 * ```
 */
export function compactDiffView(spec: CompactDiffSpec): string {
  const maxLines = spec.maxLines ?? 20;
  const statHeader = buildStatHeader(spec);

  // Collapsed mode: stat header only, no body.
  if (spec.collapsed === true || spec.hunks.length === 0) {
    return statHeader;
  }

  // Collect body items for the hunk frame.
  // Hunk @@ headers are always shown and do NOT count against maxLines.
  type Item = { kind: 'header' | 'body'; text: string };
  const items: Item[] = [];

  for (const hunk of spec.hunks) {
    const hunkHeader = sanitizeDiffText(hunk.header);
    items.push({ kind: 'header', text: palette.diffHunk(hunkHeader) });
    for (const line of hunk.lines) {
      items.push({ kind: 'body', text: colorLine(line) });
    }
  }

  // Count body lines to decide if truncation is needed.
  let totalBody = 0;
  for (const it of items) if (it.kind === 'body') totalBody++;

  const needsTruncation = maxLines > 0 && totalBody > maxLines;

  const bodyLines: string[] = [];

  if (!needsTruncation) {
    for (const it of items) bodyLines.push(it.text);
  } else {
    // Keep all hunk headers, keep the first maxLines body lines.
    let bodyCount = 0;
    for (const it of items) {
      if (it.kind === 'header') {
        bodyLines.push(it.text);
      } else if (bodyCount < maxLines) {
        bodyLines.push(it.text);
        bodyCount++;
      }
    }
    const hidden = totalBody - maxLines;
    const noun = hidden === 1 ? 'line' : 'lines';
    bodyLines.push(palette.dim(`... and ${hidden} more ${noun}`));
  }

  // Wrap body in a box. Width accounts for border + padding overhead (box adds
  // 4 cols for borders and 2 cols for default padding = 6 total).
  const termWidth = spec.width ?? 80;
  const innerWidth = Math.max(20, termWidth - 6);
  const boxed = drawBox(bodyLines, { width: innerWidth });

  return [statHeader, boxed].join('\n');
}
