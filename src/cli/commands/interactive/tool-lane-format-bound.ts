/**
 * Input bound for tool-lane outcome previews.
 *
 * Invariant: tool-lane formatting runs on every overlay render, synchronously
 * on the main event loop, for every completed row. A tool result can be one
 * enormous line (a base64 `data:` URI, minified JS, a binary dump), and any
 * formatter that is O(n) or worse on that line (path shortening,
 * display-width truncation, grapheme splitting, colorizers) then costs that
 * much on every frame. In #2568 this starved the REPL until compose children,
 * watchdogs and SIGTERM all ran tens of seconds late. The preview can only
 * ever show a terminal line's worth of text, so the raw input is cut to a
 * fixed budget BEFORE any formatter sees it. That keeps per-frame cost
 * independent of tool-output size.
 *
 * The budget is generous (far wider than any terminal) so path collapsing
 * still sees the whole visible prefix. When text is cut, a trailing `…` keeps
 * the preview honest that more followed.
 *
 * @module cli/commands/interactive/tool-lane-format-bound
 */

/** Max UTF-16 code units of raw tool output fed into preview formatting. */
export const PREVIEW_INPUT_CAP = 2048;

/**
 * Cut `text` to at most PREVIEW_INPUT_CAP code units (plus a `…` marker when
 * cut). Never splits a surrogate pair. Returns `text` unchanged when it fits.
 */
export function capPreviewInput(text: string): string {
  if (text.length <= PREVIEW_INPUT_CAP) return text;
  let end = PREVIEW_INPUT_CAP;
  const last = text.charCodeAt(end - 1);
  // A high surrogate at the cut point would be orphaned: back off one unit.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + '…';
}
