/**
 * Live-preview rendering for the Telegram streaming handler
 *
 * Pure functions for composing the in-progress message preview from accumulated
 * content, interleaved tool-progress entries, and the sub-agent footer.
 * Extracted from streaming.ts — the public surface of streaming.ts is unchanged
 * (all exports are re-exported there).
 * @module telegram/streaming.preview
 */

import { renderSubagentFooter } from './streaming.activity.js';

/**
 * Max `◦` tool-progress lines kept in the rolling live-preview region. Older
 * lines are trimmed rather than accumulated, so a long tool-heavy turn no longer
 * grows the preview without bound (which also meant one Telegram edit per round
 * against an ever-longer message). Same bounded-region treatment
 * `renderSubagentFooter` already applies to sub-agent steps.
 */
export const MAX_PROGRESS_LINES = 6;

/**
 * Max progress entries retained. Only the last MAX_PROGRESS_LINES render a
 * LABEL (the same global cap the footer enforces); older retained entries render
 * a bare line break so narration either side of a trimmed round stays separated
 * instead of running together. Past this the oldest are dropped outright, so the
 * list cannot grow with turn length.
 */
export const MAX_PROGRESS_ENTRIES = 32;

/**
 * One recorded `◦` tool-progress round: the rendered label plus the offset into
 * the content buffer at which it occurred, so the LIVE PREVIEW can place it
 * chronologically instead of piling every label into a trailing footer.
 */
export type ProgressEntry = { readonly label: string; readonly at: number };

/**
 * Render the BOUNDED `◦` tool-progress region for the live preview. Returns ''
 * for no lines. Only the last MAX_PROGRESS_LINES are shown regardless of how
 * many are passed, so a tool-heavy turn keeps a fixed-height status region
 * instead of an ever-growing log. Pure + exported for unit tests.
 */
export function renderProgressRegion(lines: readonly string[]): string {
  const shown = lines.slice(-MAX_PROGRESS_LINES);
  return shown.length > 0 ? shown.map((l) => `\n${l}`).join('') : '';
}

/**
 * Contract: return an offset at or after `pos` at which a `◦` line may be
 * inserted without corrupting markdown that `markdownToTelegramHtml` parses
 * POSITIONALLY. That formatter extracts fenced blocks and inline-code spans
 * before its emphasis passes and rewrites `[text](url)` links after them
 * (formatter.ts), so a label spliced inside an unclosed fence, between the
 * backticks of a span, or into a half-written link is swallowed into
 * `<pre>`/`<code>`/an `href` — and broken backtick parity shifts which later
 * spans code-ify. When `pos` is unsafe this degrades to the END of the text,
 * i.e. exactly where the legacy footer put the line: never worse than before.
 */
export function safeSplicePoint(text: string, pos: number): number {
  if (pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  // Drop COMPLETE fenced blocks first; a leftover ``` means the offset sits
  // inside a fence the model has not closed yet (routine mid-stream).
  //
  // External constraint: the pattern MIRRORS the formatter's own fence regex
  // (formatter.ts step 2 — line-anchored, newline required after the opening
  // fence). An unanchored /```[\s\S]*?```/ would count a single-line ```word```
  // as a complete block that the formatter does NOT see as one, report the
  // offset safe, and let the label fall into the formatter's inline-code pass.
  // Both parse models must agree or "safe" means nothing.
  const prefix = text.slice(0, pos).replace(/^ {0,3}```[\w]*\n[\s\S]*?```/gm, '');
  if (prefix.includes('```')) return text.length;
  // Odd backtick count => the offset falls inside an inline-code span.
  if (((prefix.match(/`/g)?.length) ?? 0) % 2 !== 0) return text.length;
  // A tool boundary routinely splits a link across rounds: `[docs](https://exa`
  // now, `mple.com)` next round. formatter.ts step 7 rewrites `[text](url)`
  // positionally, so a label spliced into either half is absorbed into the
  // generated href — hiding the status AND corrupting the link target. Cheap
  // prefix scan for the two open states, in the same spirit as the checks
  // above; deliberately not a markdown parser.
  const openBracket = prefix.lastIndexOf('[');
  const closeBracket = prefix.lastIndexOf(']');
  // `[label` with no `]` written yet.
  if (openBracket > closeBracket) return text.length;
  // `](url` with the closing paren still unwritten.
  if (
    closeBracket >= 0 &&
    prefix[closeBracket + 1] === '(' &&
    !prefix.includes(')', closeBracket + 1)
  ) {
    return text.length;
  }
  return pos;
}

/**
 * Render the live preview with `◦` progress lines interleaved chronologically
 * into `text` at the offsets where they occurred, instead of collected in a
 * trailing footer. Pure + exported for unit tests.
 *
 * Invariant: the GLOBAL cap on rendered labels is preserved — only the last
 * MAX_PROGRESS_LINES entries emit a `◦` label no matter how many are passed, so a
 * tool-heavy turn keeps a fixed-height status budget. That is the bound PR #702
 * established when it replaced an in-buffer splice, and it holds here for a
 * structural reason: trimming happens over the ENTRY LIST before rendering and
 * `text` is never mutated, so the failure mode of the reverted design — where
 * bounding the region required deleting from the middle of the content buffer,
 * which a following content chunk then froze in place — cannot recur.
 *
 * Offsets are clamped MONOTONICALLY into `text`, which covers mid-turn
 * TRUNCATION (`stream_retry` rewinding the buffer): an offset past the shortened
 * text collapses to the end, i.e. footer placement. It does NOT cover the
 * end-of-turn wholesale replace by the authoritative assistant message, whose
 * replacement text is frequently LONGER than an early offset — so the clamp
 * never fires and the offset is in range but meaningless. That case is handled
 * at the call site, which re-bases retained offsets to the new buffer length
 * before rendering (see the assistant-`message` handler in streamResponse).
 */
export function renderInterleavedPreview(
  text: string,
  entries: readonly ProgressEntry[],
): string {
  if (entries.length === 0) return text;
  const labelFrom = Math.max(0, entries.length - MAX_PROGRESS_LINES);
  let out = '';
  let pos = 0;
  // Suppresses a leading/duplicate break when consecutive rounds sit at the SAME
  // offset (a progress-only turn records every entry at offset 0): a bare break
  // is only meaningful when real narration separated the two rounds.
  let lastEmitAt = 0;
  entries.forEach((entry, i) => {
    const at = safeSplicePoint(text, Math.min(Math.max(entry.at, pos), text.length));
    out += text.slice(pos, at);
    pos = at;
    // Offsets are forced monotonic and safeSplicePoint is idempotent, so a NEXT
    // raw offset at or before the current effective one renders at EXACTLY this
    // position. That entry then supplies the `\n` separator itself, and emitting
    // another one here would leave a stray blank line between the narration and
    // its label.
    const nextRendersHere = (entries[i + 1]?.at ?? Infinity) <= at;
    if (i >= labelFrom) {
      out += `\n${entry.label}`;
      lastEmitAt = at;
      // Terminate the label: the next iteration appends `text.slice(pos, at)` —
      // the following round's narration — which absorbs into the label when it
      // does not start with a break (`◦ Using list schedulesNow I run…`).
      // Invariant: only when narration actually follows HERE and does not
      // already begin with `\n`. A label at END of text must stay bare, or a
      // progress-only turn stops being byte-identical to renderProgressRegion()
      // and finalBody()'s footer shape parity goes with it.
      if (!nextRendersHere && at < text.length && text[at] !== '\n') out += '\n';
    } else if (at > lastEmitAt && !nextRendersHere) {
      out += '\n';
      lastEmitAt = at;
    }
  });
  return out + text.slice(pos);
}

/**
 * State slice consumed by `computeLivePreview`. Extracted here rather than
 * inlined so `streamResponse` can pass explicit arguments instead of closing
 * over its outer scope.
 */
export interface LivePreviewState {
  readonly accumulated: string;
  readonly progressEntries: readonly ProgressEntry[];
  readonly progressGateOpen: boolean;
  readonly subagentSteps: number;
  readonly recentSubagentSteps: readonly string[];
}

/**
 * Compute the live-preview string for one in-progress Telegram edit.
 *
 * Live preview = content with the GATED progress lines interleaved at the
 * offsets where they occurred, plus the bounded sub-agent footer. Used for every
 * in-turn edit so progress and sub-agent activity stay visible without either
 * region growing one line per tool call. Interleaving (rather than a trailing
 * footer) is what keeps each round's narration next to the tool round it
 * describes, and supplies the line break between consecutive rounds that
 * `accumulated += content` does not.
 *
 * Module-level replacement for the former inner closure `livePreview()` in
 * `streamResponse`. Takes explicit state to avoid closing over mutable outer
 * variables.
 */
export function computeLivePreview(state: LivePreviewState): string {
  return (
    (state.progressGateOpen
      ? renderInterleavedPreview(state.accumulated, state.progressEntries)
      : state.accumulated) + renderSubagentFooter(state.subagentSteps, state.recentSubagentSteps)
  );
}
