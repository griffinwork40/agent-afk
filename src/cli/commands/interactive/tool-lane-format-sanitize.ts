import { stripAnsi } from '../../display.js';

// Intent: label / paragraph variant. Strips ALL C0 (0x00–0x1F) including
// LF + every C1 control (0x7F–0x9F). Labels must fit on a single terminal
// row, so LF is treated as whitespace and replaced by a space; paragraphs
// are pre-split on '\n' by the caller so embedded LF here would be an
// upstream bug — collapsing to space is the safe failure mode. C1
// controls covered for the same reason as CONTROL_CHAR_RE (8-bit-mode
// terminals can interpret them as CSI introducers).
//
// USE FOR: sanitizeLabel / sanitizeTextParagraph (LLM-controlled strings).
// DON'T USE FOR: diff-line content (would strip LF / break structure).
const CONTROL_CHAR_LABEL_RE = /[\x00-\x1F\x7F-\x9F]/g;

/**
 * Strip all ANSI/control-code sequences from an LLM-sourced single-line
 * label before rendering. Combines stripAnsi (CSI / OSC / DCS / bare ESC
 * sequences) with a C0+C1+DEL scrub so adversarial `toolInput`,
 * `thinkingTail`, or grouped-target labels cannot inject terminal control
 * sequences through the tool-lane display.
 *
 * This is the canonical sanitizer for single-line LLM-controlled strings.
 * Trims leading/trailing whitespace and collapses internal whitespace runs
 * to a single space — appropriate for label contexts where leading
 * indentation has no meaning (`toolInput`, outcome previews, thinking
 * tails). For multi-line paragraph content where leading indentation
 * carries meaning (e.g. markdown list bullets), use
 * {@link sanitizeTextParagraph} instead.
 *
 * Note: LF (0x0A) is replaced with a space (via CONTROL_CHAR_LABEL_RE)
 * because this function targets single-line contexts. Multi-line text
 * children are split on '\n' before sanitization in renderTextChildLines.
 */
export function sanitizeLabel(raw: string): string {
  // stripAnsi removes full ESC-prefixed sequences (CSI, OSC, DCS, PM, APC,
  // SOS, and bare 2-byte ESC+X). CONTROL_CHAR_LABEL_RE then catches any
  // remaining bare C0 + C1 + DEL bytes (BEL, CR, LF, NUL, …) that are not
  // ESC-prefixed. Whitespace collapse + trim shape the result to fit a
  // single-line label slot.
  return stripAnsi(raw).replace(CONTROL_CHAR_LABEL_RE, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * Paragraph variant of {@link sanitizeLabel}. Strips the same byte ranges
 * (ANSI, C0, C1, DEL via CONTROL_CHAR_LABEL_RE) but does NOT collapse
 * internal whitespace and does NOT trim leading/trailing whitespace.
 *
 * Why a separate function: subagent narration arrives as multi-line
 * markdown with meaningful indentation (e.g. `"  - item one"`). After
 * `text.split('\n')` in renderTextChildLines, each paragraph still carries
 * its leading spaces as structural information for the wrap+render path.
 * sanitizeLabel's trim + multi-space collapse would flatten
 * `"  - item one"` to `"- item one"`, destroying list indentation
 * visually. This variant preserves indentation while still blocking every
 * control-code injection vector.
 *
 * Returns input unchanged when no ANSI / control bytes are present.
 */
export function sanitizeTextParagraph(raw: string): string {
  return stripAnsi(raw).replace(CONTROL_CHAR_LABEL_RE, ' ');
}
