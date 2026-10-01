/**
 * Memo for the pending overlay's formatted render.
 *
 * While the reveal animates, the frame clock repaints the pending overlay at
 * 60 fps even when no text arrived, and every repaint used to re-run the
 * whole markdown pipeline (inline-close, render, wrap) on an unchanged
 * buffer. This cache makes such a frame a key comparison.
 *
 * Invariant (complete key): the cached render is reused only when every
 * input that `formatPendingBuffer` reads is unchanged: the buffer, the
 * content width, the render flag, the viewport row cap (it truncates the
 * render), the active theme and chalk color level (palette tones), plus the
 * open-fence / open-table state. The last two are pure functions of the
 * buffer, so they are computed once per buffer and cached with it, which
 * also spares the caller re-scanning the buffer every frame.
 *
 * @module cli/markdown-stream.pending-cache
 */

import chalk from 'chalk';
import { formatPendingBuffer, isInOpenCodeFence, isInOpenTable, pendingRowCap } from './markdown-stream-format.js';
import { getActiveTheme } from './theme.js';

export interface PendingRender {
  formatted: string;
  inCode: boolean;
  inTable: boolean;
  /** Line count of `formatted`. */
  rows: number;
  /** Viewport row cap the render was truncated to. */
  rowCap: number;
}

type Format = (buffer: string, contentWidth: number, shouldRender: boolean) => string;

export class PendingFormatCache {
  private key: string | null = null;
  /** Buffer the cached `value` was rendered from. */
  private source: string | null = null;
  private buffer: string | null = null;
  private state = { inCode: false, inTable: false };
  private value: PendingRender | null = null;

  constructor(private readonly format: Format = formatPendingBuffer) {}

  /** Open-fence / open-table state of `buffer`, computed once per buffer. */
  blockState(buffer: string): { inCode: boolean; inTable: boolean } {
    if (buffer !== this.buffer) {
      this.buffer = buffer;
      this.state = { inCode: isInOpenCodeFence(buffer), inTable: isInOpenTable(buffer) };
    }
    return this.state;
  }

  /** `formatPendingBuffer(buffer, contentWidth, shouldRender)`, memoized on the full key. */
  render(buffer: string, contentWidth: number, shouldRender: boolean): PendingRender {
    const { inCode, inTable } = this.blockState(buffer);
    const rowCap = pendingRowCap();
    const key = `${contentWidth}|${shouldRender ? 1 : 0}|${rowCap}|${getActiveTheme()}|${chalk.level}|${inCode ? 1 : 0}${inTable ? 1 : 0}`;
    if (this.value && key === this.key && buffer === this.source) return this.value;
    const formatted = this.format(buffer, contentWidth, shouldRender);
    this.key = key;
    this.source = buffer;
    this.value = { formatted, inCode, inTable, rows: formatted.split('\n').length, rowCap };
    return this.value;
  }

  /** Drop the memo (e.g. the buffer was discarded). */
  clear(): void {
    this.key = null;
    this.source = null;
    this.buffer = null;
    this.value = null;
  }
}
