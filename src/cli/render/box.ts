import type { ChalkInstance } from 'chalk';
import { displayWidth, padDisplayRight, truncateDisplayWidth } from '../display.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';
import { maxInnerBoxWidth } from './utils.js';

/** Options for {@link drawBox}. */
export interface DrawBoxOptions {
  /** Border color (a chalk instance / palette role). Defaults to `palette.dim`. */
  border?: ChalkInstance;
  /** Optional title rendered as a bold chip in the top border. */
  title?: string;
  /**
   * Inner content width in columns (excludes border + padding). When omitted,
   * the box fits its content. Always clamped to {@link maxInnerBoxWidth} so the
   * border fits the terminal.
   */
  width?: number;
  /**
   * Horizontal inner padding (spaces) between border and content on each side.
   * Defaults to 1.
   */
  padding?: number;
}

const TL = '╭';
const TR = '╮';
const BL = '╰';
const BR = '╯';
const H = '─';
const V = '│';

/**
 * Render a minimal rounded-corner box around `content`.
 *
 * A low-level, reusable layout primitive: it computes a rectangular inner
 * width, wraps each content line to fit, clamps + pads every line to equal
 * width, and frames the result with a colored border and optional title chip.
 * Mirrors the shape vocabulary of {@link card} / {@link errorBox} (rounded
 * corners, 1-col default padding) so those callers can later be unified onto it.
 *
 * Content wider than the inner width is word-wrapped; an unbreakable token
 * still wider than the inner width is truncated with an ellipsis so the box
 * stays rectangular. A `title` wider than the box (e.g. a long dynamic name,
 * or a terminal narrower than the title) is likewise truncated to fit the top
 * border — the rectangularity guarantee holds for every input.
 *
 * Both `content` and `title` are assumed pre-sanitised and trusted — this
 * primitive does NOT strip escape sequences. Untrusted (tool / model / user)
 * strings MUST be passed through `sanitizeForDisplay`
 * (src/utils/terminal-sanitize.ts) before reaching here.
 *
 * @param content One string (split on `\n`) or an array of lines.
 * @param opts    Border color, title, width, and padding overrides.
 * @returns A multi-line string ready to write to stdout.
 */
export function drawBox(content: string | string[], opts: DrawBoxOptions = {}): string {
  const border = opts.border ?? palette.dim;
  const padding = Math.max(0, Math.trunc(opts.padding ?? 1));
  const title = opts.title;
  const sourceLines = Array.isArray(content) ? content : content.split('\n');

  const maxInner = maxInnerBoxWidth();
  // A title needs its own width plus one leading dash inside the top border.
  const titleW = title !== undefined ? displayWidth(` ${title} `) : 0;
  const contentW = sourceLines.reduce((m, line) => Math.max(m, displayWidth(line)), 0);

  let innerW =
    opts.width !== undefined
      ? Math.max(1, Math.trunc(opts.width))
      : Math.max(1, contentW, titleW + 1);
  innerW = Math.min(innerW, maxInner);
  // Keep the title fitting even after clamping to the terminal width.
  innerW = Math.max(innerW, Math.min(titleW + 1, maxInner));

  const pad = ' '.repeat(padding);
  const horizontalRun = innerW + padding * 2;

  // Top border, optionally interrupted by a bold title chip. The visible run
  // between the corners equals `horizontalRun` in both branches so the box is
  // rectangular: TL + H + chip + dashes + TR  ==  TL + H*horizontalRun + TR.
  let top: string;
  if (title !== undefined) {
    // Invariant: the chip occupies at most `horizontalRun - 1` columns — the
    // layout is TL + H(1) + chip + dashes(>=0) + TR. When the title is wider
    // than the box (a long dynamic name, or a terminal narrower than the
    // title, where innerW was clamped to maxInner), truncate the chip to fit.
    // Without this, `dashes` bottoms out at 0 while the full chip is still
    // emitted, so the top border grows past the body rows and the box loses
    // its rectangularity guarantee.
    const maxChipW = horizontalRun - 1;
    let chip = ` ${title} `;
    if (displayWidth(chip) > maxChipW) chip = truncateDisplayWidth(chip, maxChipW);
    const chipW = displayWidth(chip);
    if (chipW > 0 && chipW <= maxChipW) {
      const dashes = horizontalRun - 1 - chipW;
      top = border(TL + H) + border.bold(chip) + border(H.repeat(dashes) + TR);
    } else {
      // Degenerate: no room for even a one-column truncated chip — plain border.
      top = border(TL + H.repeat(horizontalRun) + TR);
    }
  } else {
    top = border(TL + H.repeat(horizontalRun) + TR);
  }

  const bar = border(V);
  const bodyLines: string[] = [];
  for (const line of sourceLines) {
    for (const wrapped of wrapToWidth(line, innerW).split('\n')) {
      const fitted = padDisplayRight(truncateDisplayWidth(wrapped, innerW), innerW);
      bodyLines.push(bar + pad + fitted + pad + bar);
    }
  }

  const bottom = border(BL + H.repeat(horizontalRun) + BR);
  return [top, ...bodyLines, bottom].join('\n');
}
