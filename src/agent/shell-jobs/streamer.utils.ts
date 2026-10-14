/**
 * Shared leaf utilities for the shell-job streamer.
 *
 * Extracted from `streamer.ts` into a separate leaf module so that
 * `streamer.helpers.ts` can import them without creating a circular
 * dependency with `streamer.ts` (issue #3725).
 *
 * `streamer.ts` re-exports these symbols so no external importer needs
 * to change its import path.
 *
 * @module agent/shell-jobs/streamer.utils
 */

/**
 * ANSI / VT escape sequence regex — strips:
 *   • CSI sequences:  ESC [ … letter          (colours, cursor, erase, …)
 *   • OSC sequences:  ESC ] … BEL  or  ESC ] … ST   (hyperlinks, title sets)
 *   • DCS sequences:  ESC P … ST                    (device control strings)
 *   • PM  sequences:  ESC ^ … ST                    (privacy message)
 *   • APC sequences:  ESC _ … ST                    (application program cmd)
 *   • SOS sequences:  ESC X … ST                    (start of string)
 *   • Single-char ESC sequences:  ESC + one byte in 0x40-0x5F EXCEPT the
 *                                 string-introducers ] P ^ _ X
 *                                 (e.g. ESC M reverse-index — but NOT ESC ]).
 *
 * The single-char alternative deliberately EXCLUDES the string-introducer
 * bytes ] (OSC), P (DCS), ^ (PM), _ (APC), X (SOS). Those bytes only ever
 * introduce a longer string sequence whose terminator (BEL / ST) may arrive
 * in a LATER chunk. If the single-char alt could match `ESC ]` on its own it
 * would strip the 2-byte introducer and leak the sequence body as literal
 * text (e.g. a hyperlink `ESC ]8;;URL BEL` split right after `ESC ]` would
 * surface `8;;URL` to the model). Excluding them lets the partial-carry in
 * `makeAnsiStripper` hold the introducer as residue until the terminator
 * lands. (PR #565 review: L3 — caught by a cross-chunk OSC-split test.)
 *
 * Excluded set as ranges: 0x40-0x4F (@-O), 0x51-0x57 (Q-W), 0x59-0x5A (YZ),
 * 0x5C (\). Dropped vs. the naive 0x40-0x5F: P(0x50) X(0x58) ](0x5D)
 * ^(0x5E) _(0x5F).
 *
 * String Terminator (ST) is BEL (\x07) or ESC \ (\x1b\x5c).
 * The body consumer `[^\x07\x1b]*` stops at the first ESC or BEL so a
 * malformed sequence never consumes content past its intended boundary.
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX =
  /\x1b(?:\[[0-9;]*[a-zA-Z]|[\]P^_X][^\x07\x1b]*(?:\x07|\x1b\\)|[@-OQ-WYZ\\])/g;

/**
 * Stateful ANSI stripper interface. Exported for direct unit testing of the
 * cross-chunk split-sequence path (PR #565 review: L3).
 */
export interface AnsiStripper {
  /** Strip ANSI sequences from `text`, carrying any partial sequence across calls. */
  strip(text: string): string;
  /**
   * Flush any partial ESC sequence held from the last chunk.
   * Call once when the stream closes so the residue is not silently dropped.
   * A partial escape sequence is never printable text, so flush() discards it
   * rather than appending raw escape bytes to modelCaptured.
   * After flush(), the residue is cleared — calling strip() again is safe.
   */
  flush(): string;
}

/**
 * Returns a stateful ANSI stripper that carries a partial-sequence residual
 * across calls. This handles the case where an ESC sequence is split across
 * two `data` chunks from the child process pipe.
 *
 * The residual holds an incomplete ESC sequence tail that was at the end of
 * the previous chunk; it is prepended to the next chunk before regex-stripping,
 * then the new tail is checked for another partial sequence. Call flush() once
 * when the stream closes to discard any residue not followed by a final chunk.
 *
 * Exported for direct unit testing — forcing a split ESC sequence through a
 * real spawned process is non-deterministic, so the carry/flush behaviour is
 * verified against this factory directly (PR #565 review: L3).
 */
export function makeAnsiStripper(): AnsiStripper {
  let residue = '';
  return {
    strip(text: string): string {
      const input = residue + text;
      // Remove all complete ANSI sequences (CSI, OSC, DCS, single-char ESC, …).
      const stripped = input.replace(ANSI_REGEX, '');
      // Hold any trailing partial ESC sequence for the next chunk.
      // Covers: bare ESC, ESC+[, ESC+[digits (CSI partial),
      //         ESC+] / ESC+P / ESC+^ / ESC+_ / ESC+X (OSC/DCS — body not yet closed).
      // eslint-disable-next-line no-control-regex
      const partialMatch = stripped.match(/\x1b(?:[\]P^_X][^\x07\x1b]*|\[[0-9;]*)?$/);
      if (partialMatch) {
        residue = partialMatch[0];
        return stripped.slice(0, stripped.length - residue.length);
      }
      residue = '';
      return stripped;
    },
    flush(): string {
      // The residue is a fragment of an incomplete ESC sequence — not printable
      // text — so discard it rather than exposing raw escape bytes to the model.
      // Reset so strip() works correctly if called again after flush().
      residue = '';
      return '';
    },
  };
}

/**
 * Truncate a UTF-8 Buffer to at most `maxBytes` bytes without splitting a
 * multi-byte code-point. Walks backward from the cut offset, skipping
 * continuation bytes (0x80–0xBF), to find the last complete character
 * boundary. Returns a subarray view (zero-copy).
 *
 * Exported for direct unit testing of the multi-byte-straddles-cap boundary
 * (PR #565 review: L4).
 */
export function utf8SafeTruncate(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  // Skip over UTF-8 continuation bytes so we don't split a multi-byte char.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}
