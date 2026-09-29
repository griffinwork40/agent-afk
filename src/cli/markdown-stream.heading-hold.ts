/**
 * Heading hold for the smoke accent (AFK_SMOKE_TEXT=1 only).
 *
 * The renderer commits a block to scrollback the moment the buffer holds its
 * `\n\n` boundary, and committed text is written once with no reveal. A
 * heading's boundary almost always streams in tens of milliseconds after the
 * heading itself, so without a hold the smoke accent would be cut off after
 * a frame or two: a flicker, not a moment. This module splits an incoming
 * chunk at the character that would complete a HEADING block's boundary, so
 * the renderer can hold the rest until the heading has condensed.
 *
 * Contract: only a block whose last line is a markdown heading (or a
 * bold-only title) qualifies. This hold waits on the SMOKE dwell and has no
 * time limit; every other animated block (ink prose, and headings when the
 * accent is off) gets a bounded deferred commit from
 * markdown-stream.commit-defer.ts instead. The owner must release held text
 * synchronously before any path that commits or inspects the buffer, so
 * nothing can be committed above a heading that preceded it.
 *
 * Extended: a bold-only first line (`**text**`) is also held, matching the
 * smoke-reveal.lines.ts LineClassifier extension that treats it as a heading.
 * Models frequently respond with a bold title instead of `# title` — without
 * the hold, the smoke accent would be cut off immediately.
 *
 * @module cli/markdown-stream.heading-hold
 */

import { findBlockBoundary } from './markdown-stream-format.js';

const HEADING_LINE_RE = /^ {0,3}#{1,6}(\s|$)/;
/** Bold-only title: line starts with `**` or `*` followed by non-whitespace. */
const BOLD_TITLE_RE = /^\*{1,2}\S/;

/**
 * True if `block` (the trimmed text of a completed block) looks like a title:
 * either a markdown heading or a bold-only single-line block (no interior
 * newlines after trimming, so we only hold single-row bold blocks).
 */
function looksLikeTitle(block: string, isFirstBlock: boolean): boolean {
  const lastLine = block.slice(block.lastIndexOf('\n') + 1);
  if (HEADING_LINE_RE.test(lastLine)) return true;
  // Bold-only title: the whole block is one line starting with ** or *.
  // We conservatively require no interior newlines to avoid holding long
  // multi-line blocks that happen to start bold.
  // Only the response's first block can be a bold title, matching the
  // LineClassifier's first-line window; a later one-line bold paragraph would
  // otherwise be held for the smoke dwell with no smoke drawn.
  return isFirstBlock && !block.includes('\n') && BOLD_TITLE_RE.test(block.trimStart());
}

/**
 * If appending `chunk` to `buffer` completes a block whose last line is a
 * heading or bold-only title, return the part of `chunk` to push now (up to,
 * not including, the character that completes the boundary) and the rest to
 * hold. Otherwise null.
 */
export function splitAtHeadingBoundary(
  buffer: string,
  chunk: string,
  isFirstBlock = true,
): { now: string; held: string } | null {
  const combined = buffer + chunk;
  const boundary = findBlockBoundary(combined);
  // The completing character must be in THIS chunk (index >= buffer.length).
  if (boundary === -1 || boundary - 1 < buffer.length) return null;
  const block = combined.slice(0, boundary).trimEnd();
  if (!looksLikeTitle(block, isFirstBlock)) return null;
  const cut = boundary - 1 - buffer.length;
  return { now: chunk.slice(0, cut), held: chunk.slice(cut) };
}
