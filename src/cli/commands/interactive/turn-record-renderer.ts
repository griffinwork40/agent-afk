/**
 * TurnRecord adapter for the resume preview view-mode.
 *
 * Converts a StoredSession's `TurnRecord[]` array into rendered terminal
 * lines suitable for display in the view-mode screen before committing to
 * a session resume. This is the bridge between the `/resume` data model
 * (TurnRecord from slash/types.ts) and the task-view rendering conventions
 * established by task-view-mode.ts.
 *
 * Rendering contract per turn:
 *   ┌──────────────────────────────┐
 *   │ User header (dim · User:)    │
 *   │   user text (indented)       │
 *   │                              │
 *   │ Assistant header (dim · …)   │
 *   │   assistant text (indented)  │
 *   │                              │
 *   │ Tool events summary (if any) │
 *   │   ─ separator ─              │
 *   └──────────────────────────────┘
 *
 * Styling conventions mirror task-view-mode.ts:
 *   - `palette.user`    for the user role header
 *   - `palette.heading` for the assistant role header
 *   - `palette.dim`     for meta lines, tool summaries, separators
 *   - `palette.bold`    for role badge text within headers
 *
 * @module cli/commands/interactive/turn-record-renderer
 */

import { palette } from '../../palette.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { summarizeToolEvents } from '../../summarize-tool-events.js';
import type { TurnRecord } from '../../slash/types.js';
import type { Writer } from '../../slash/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max characters of user/assistant text to display per turn. */
const MAX_CONTENT_CHARS = 600;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Separator line sized to terminal width (max 100). */
function sep(): string {
  const w = Math.min(getTerminalWidth(), 100);
  return palette.dim('─'.repeat(w));
}

/**
 * Hard-truncate text to `max` characters, appending an ellipsis indicator
 * when truncation occurs so the user knows the preview is incomplete.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/**
 * Render a multi-line block of text with consistent 2-space indentation.
 * Each line of the source text becomes an indented line in the output.
 * Empty lines are preserved as blank indented lines for readability.
 */
function indentBlock(text: string, out: Writer): void {
  const lines = text.split('\n');
  for (const line of lines) {
    out.line(`  ${line}`);
  }
}

/**
 * Format a concise per-turn metadata footer showing cost and duration when
 * the values are present and non-zero.
 */
function formatTurnMeta(turn: TurnRecord): string | null {
  const parts: string[] = [];
  if (typeof turn.costUsd === 'number' && turn.costUsd > 0) {
    parts.push(`$${turn.costUsd.toFixed(4)}`);
  }
  if (typeof turn.durationMs === 'number' && turn.durationMs > 0) {
    const secs = (turn.durationMs / 1000).toFixed(1);
    parts.push(`${secs}s`);
  }
  if (parts.length === 0) return null;
  return palette.dim(`  [${parts.join(' · ')}]`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the header block for a resume preview view.
 * Shows the session name/id and turn count before the conversation body.
 */
export function renderResumeViewHeader(opts: {
  name?: string;
  id: string;
  totalTurns: number;
}): string {
  const w = Math.min(getTerminalWidth(), 100);
  const hr = palette.dim('─'.repeat(w));
  const label = opts.name ? `${opts.name}  ${palette.dim(`(${opts.id.slice(0, 12)})`)}` : opts.id.slice(0, 20);
  const turns = `${opts.totalTurns} turn${opts.totalTurns === 1 ? '' : 's'}`;
  const title = palette.bold(`Session: ${label}`) + '  ' + palette.dim(turns);
  return [hr, title, hr].join('\n');
}

/**
 * Footer lines shown below the conversation preview.
 *
 * `state` drives the message:
 *   - `'preview'` — Enter to resume, Esc to cancel
 *   - `'cancelled'` — resume cancelled
 *   - `'resuming'` — resuming in progress
 */
export function buildResumeFooterLine(state: 'preview' | 'cancelled' | 'resuming'): string {
  if (state === 'cancelled') {
    return palette.dim('  Resume cancelled — returned to prompt.');
  }
  if (state === 'resuming') {
    return palette.dim('  Resuming session…');
  }
  return palette.dim('  Press Enter to resume this session, Esc to cancel');
}

/**
 * Render `turns` as a human-readable conversation preview, writing each
 * line to `out`.
 *
 * Each TurnRecord is rendered as:
 *   user header → indented user text →
 *   assistant header → indented assistant text →
 *   tool summary (if any) → turn meta (cost/duration) → separator
 *
 * Empty turns (both user and assistant empty) are skipped.
 * Missing `user` or `assistant` fields degrade gracefully to an
 * empty-content placeholder.
 *
 * @param turns    Array of TurnRecord to render (may be empty).
 * @param out      Writer sink — lines are emitted via `out.line()`.
 * @param limit    Maximum number of turns to render (default: all).
 */
export function renderTurnRecords(
  turns: readonly TurnRecord[],
  out: Writer,
  limit?: number,
): void {
  if (turns.length === 0) {
    out.line(palette.dim('  (no turns recorded)'));
    return;
  }

  const cap = limit !== undefined && limit > 0 ? limit : turns.length;
  const slice = turns.slice(Math.max(0, turns.length - cap));
  if (slice.length < turns.length) {
    out.line(palette.dim(`  … ${turns.length - slice.length} earlier turn${turns.length - slice.length === 1 ? '' : 's'} not shown`));
    out.line('');
  }

  for (const turn of slice) {
    const userText = (turn.user ?? '').trim();
    const assistantText = (turn.assistant ?? '').trim();

    // Skip entirely empty turns (should not happen in production data).
    if (userText.length === 0 && assistantText.length === 0) continue;

    // ── User block ────────────────────────────────────────────────────────
    out.line(palette.dim('·') + ' ' + palette.user('User'));
    if (userText.length > 0) {
      indentBlock(truncate(userText, MAX_CONTENT_CHARS), out);
    } else {
      out.line(palette.dim('  (empty)'));
    }
    out.line('');

    // ── Assistant block ───────────────────────────────────────────────────
    out.line(palette.dim('·') + ' ' + palette.heading('Assistant'));
    if (assistantText.length > 0) {
      indentBlock(truncate(assistantText, MAX_CONTENT_CHARS), out);
    } else {
      out.line(palette.dim('  (empty)'));
    }
    out.line('');

    // ── Tool events summary ───────────────────────────────────────────────
    if (turn.toolEvents && turn.toolEvents.length > 0) {
      const summary = summarizeToolEvents(turn.toolEvents);
      if (summary.length > 0) {
        // summarizeToolEvents prefixes with \n; strip it for indented display.
        const trimmed = summary.replace(/^\n/, '');
        out.line(palette.dim(`  ${trimmed}`));
        out.line('');
      }
    }

    // ── Per-turn metadata (cost / duration) ───────────────────────────────
    const meta = formatTurnMeta(turn);
    if (meta !== null) {
      out.line(meta);
    }

    // ── Turn separator ────────────────────────────────────────────────────
    out.line(sep());
    out.line('');
  }
}
