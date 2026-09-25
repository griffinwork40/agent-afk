/**
 * scrollbackSeparator — trailing-band separator for ToolLane.flushSource.
 *
 * Spine-continuation separator: when the flushed subagent entry sits under
 * a live ancestor (compose/skill), the trailing row carries the ancestor's
 * dim `│` column so it stays visually continuous between sibling bands in
 * scrollback. At root depth (0 ancestors) the separator is an empty string
 * `''`, which the caller commits as a dedicated `compositor.commitAbove('')`
 * so the compositor paints exactly one blank row — the pre-PR breathing-room
 * behavior that `commitBlockAbove` alone does not reproduce (it joins lines
 * on `\n`, and `decomposeCommitText` strips a lone trailing `\n` as a line
 * terminator rather than a blank row).
 *
 * @module cli/commands/interactive/tool-lane.scrollback-separator
 */

import { getGlyphs } from './tool-lane-render.js';
import { palette } from '../../palette.js';

/**
 * Build the trailing separator element for a `flushSource` return value.
 *
 * @param depth - Number of live ancestors (= `ancestorIsLast.length`).
 *   0 = root depth; >0 = nested under a compose/skill ancestor.
 * @returns A dim spine string at depth > 0, or `''` at root depth.
 */
export function scrollbackSeparator(depth: number): string {
  if (depth > 0) {
    const g = getGlyphs();
    return palette.dim(g.spine.repeat(depth));
  }
  return '';
}
