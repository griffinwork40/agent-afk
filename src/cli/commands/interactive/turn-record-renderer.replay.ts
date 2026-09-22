/**
 * Replay renderer for resumed sessions.
 *
 * Prints the full stored conversation to the terminal on session resume so
 * it looks like you never left. Used by `printResumeBanner` in `shared.ts`
 * to replace the previous 3-line summary with a complete scrollback replay.
 *
 * Rendering contract per turn:
 *   ─ dim separator ─
 *   ▸ User   (cyan, role header)
 *       user text (4-space indent, full, whitespace-collapsed)
 *   ◂ Assistant  (bold-white, role header)
 *       assistant text (4-space indent; truncated at 2000 chars for very long responses)
 *   dim tool-event summary line (if toolEvents present)
 *   dim stats line (if costUsd or durationMs present)
 *
 * @module cli/commands/interactive/turn-record-renderer.replay
 */

import { palette } from '../../palette.js';
import { summarizeToolEvents } from '../../summarize-tool-events.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import type { TurnRecord } from '../../slash/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum turns to show. Older turns beyond this are summarized with a divider. */
const DEFAULT_MAX_TURNS = 50;

/**
 * Assistant text longer than this is shown truncated with a char-count annotation.
 * User text is not truncated (collapse + full display).
 */
const ASSISTANT_TRUNCATE_CHARS = 2000;

/** How many characters of the assistant text to show when truncating. */
const ASSISTANT_TRUNCATE_SHOW = 1500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse consecutive whitespace (including newlines) to single spaces and
 * strip ANSI escape sequences. Makes multi-line stored text readable as a
 * single flat line without losing any content.
 */
function collapseWhitespace(s: string): string {
  const stripped = stripEscapeSequences(s);
  return stripped.replace(/\s+/g, ' ').trim();
}

/**
 * Emit `text` indented by 4 spaces via `writer`. Each physical newline in
 * `text` becomes a new indented line — so whitespace-collapsed text produces
 * a single indented line.
 */
function emitIndented(text: string, writer: (line: string) => void): void {
  const lines = text.split('\n');
  for (const line of lines) {
    writer(`    ${line}`);
  }
}

/**
 * Format a per-turn stats footer (cost + duration). Returns null when neither
 * value is present or non-zero.
 */
function formatStats(turn: TurnRecord): string | null {
  const parts: string[] = [];
  if (typeof turn.costUsd === 'number' && turn.costUsd > 0) {
    parts.push(`$${turn.costUsd.toFixed(4)}`);
  }
  if (typeof turn.durationMs === 'number' && turn.durationMs > 0) {
    parts.push(`${(turn.durationMs / 1000).toFixed(1)}s`);
  }
  if (parts.length === 0) return null;
  return palette.dim(`  [${parts.join(' · ')}]`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Replay a stored conversation to the terminal by writing each turn through
 * the supplied `writer` function. Designed to be called from `printResumeBanner`
 * so a resumed session visually picks up exactly where it left off.
 *
 * When `records.length > maxTurns`, older turns are omitted and a dim divider
 * line explains how many were skipped. Only the most recent `maxTurns` turns
 * are rendered.
 *
 * Writer isolation: every line goes through the `writer` param so the
 * caller controls routing (commitAbove vs console.log vs test collector).
 *
 * @param records  Full turn history from `SessionStats.turns`.
 * @param writer   Line sink — receives one styled string per call.
 * @param opts     `maxTurns` — how many recent turns to show (default 50).
 */
export function replayTurns(
  records: readonly TurnRecord[],
  writer: (line: string) => void,
  opts?: { maxTurns?: number },
): void {
  if (records.length === 0) return;

  const maxTurns = opts?.maxTurns ?? DEFAULT_MAX_TURNS;
  const omitted = Math.max(0, records.length - maxTurns);
  const slice = omitted > 0 ? records.slice(omitted) : records;

  // Emit omitted-turns notice before the replay window.
  if (omitted > 0) {
    writer(palette.dim(`    ... ${omitted} earlier turn${omitted === 1 ? '' : 's'} omitted`));
  }

  for (const turn of slice) {
    const userText = collapseWhitespace(turn.user ?? '');
    const assistantRaw = (turn.assistant ?? '').trim();

    // Skip degenerate turns where both sides are empty after normalization.
    if (userText.length === 0 && assistantRaw.length === 0) continue;

    // ── Separator ─────────────────────────────────────────────────────────
    writer(palette.dim('  ─────'));

    // ── User block ────────────────────────────────────────────────────────
    writer(palette.user('  ▸ User'));
    if (userText.length > 0) {
      emitIndented(userText, writer);
    } else {
      writer(palette.dim('    (empty)'));
    }

    // ── Assistant block ───────────────────────────────────────────────────
    writer(palette.heading('  ◂ Assistant'));
    if (assistantRaw.length > 0) {
      // Strip ANSI before display — assistant text may contain cursor-control
      // sequences from tool output embedded in prior responses.
      const stripped = stripEscapeSequences(assistantRaw);
      if (stripped.length > ASSISTANT_TRUNCATE_CHARS) {
        const shown = stripped.slice(0, ASSISTANT_TRUNCATE_SHOW);
        emitIndented(shown, writer);
        writer(palette.dim(`    ... (truncated, ${stripped.length} chars total)`));
      } else {
        emitIndented(stripped, writer);
      }
    } else {
      writer(palette.dim('    (empty)'));
    }

    // ── Tool events ───────────────────────────────────────────────────────
    if (turn.toolEvents && turn.toolEvents.length > 0) {
      const summary = summarizeToolEvents(turn.toolEvents);
      if (summary.length > 0) {
        // summarizeToolEvents returns a string starting with \n — strip it.
        const trimmed = stripEscapeSequences(summary.replace(/^\n/, ''));
        writer(palette.dim(`  ${trimmed}`));
      }
    }

    // ── Stats footer ──────────────────────────────────────────────────────
    const stats = formatStats(turn);
    if (stats !== null) {
      writer(stats);
    }
  }
}
