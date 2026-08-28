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
import { drawBox } from './box.js';
import { sanitizeForDisplay, stripEscapeSequences } from '../../utils/terminal-sanitize.js';

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
  // Pass 1: strip all escape sequences including 8-bit C1 CSI (\x9B…) via the
  // canonical two-pass scrubber's escape regex — without trimming, so leading
  // diff prefixes ("+", "-", " ") survive.
  // Pass 2: remove remaining bare control bytes (C0 except TAB/LF, DEL, C1).
  return stripEscapeSequences(raw).replace(CONTROL_CHAR_RE, '');
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
  const fp = palette.fileRef(sanitizeForDisplay(spec.filePath));
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

  // Both collapsed mode and an empty hunk list share the same early return:
  // neither has body content to render, so the stat header is the entire output.
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
    // Keep hunk headers only when at least one of their body lines will render.
    // Suppress headers whose entire body falls beyond the cap (orphan headers).
    let bodyCount = 0;
    let pendingHeader: string | null = null;
    for (const it of items) {
      if (it.kind === 'header') {
        // Defer: only emit if a body line follows within the cap.
        pendingHeader = it.text;
      } else if (bodyCount < maxLines) {
        // Flush the deferred header before the first body line in this hunk.
        if (pendingHeader !== null) {
          bodyLines.push(pendingHeader);
          pendingHeader = null;
        }
        bodyLines.push(it.text);
        bodyCount++;
      }
    }
    const hidden = totalBody - maxLines;
    const noun = hidden === 1 ? 'line' : 'lines';
    bodyLines.push(palette.dim(`... and ${hidden} more ${noun}`));
  }

  // Wrap body in a box. BOX_OVERHEAD matches the constant used in utils.ts
  // (maxInnerBoxWidth): 2 border cols + 2×1 default padding col on each side = 6.
  // Named here so a change to drawBox's padding default causes a single update
  // rather than a silent numeric mismatch.
  const BOX_OVERHEAD = 6; // 2 border + 2×padding(1) on each side — mirrors utils.ts
  const termWidth = spec.width ?? 80;
  const innerWidth = Math.max(20, termWidth - BOX_OVERHEAD);
  const boxed = drawBox(bodyLines, { width: innerWidth });

  return [statHeader, boxed].join('\n');
}
