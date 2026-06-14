import { getTerminalWidth } from './terminal-size.js';
import { renderMarkdownToTerminal } from './formatter.js';
import { wrapToWidth } from './wrap.js';

/**
 * Pure markdown formatting and analysis helpers for StreamingMarkdownRenderer.
 * These functions are stateless and do not depend on instance state.
 */

/**
 * Calculate content width for text wrapping based on indentation.
 * Accounts for terminal width and indent offset.
 */
export function calculateContentWidth(indentLength: number): number {
  const termWidth = Math.max(1, getTerminalWidth() - 2);
  return Math.max(1, termWidth - indentLength);
}

/**
 * Render text block using either markdown or plain text wrapping.
 * Chooses rendering strategy based on markdown content detection.
 */
export function renderTextBlock(text: string, contentWidth: number): string {
  const isMarkdown = hasMarkdownContent(text);
  if (isMarkdown) {
    return renderMarkdownToTerminal(text, { maxWidth: contentWidth });
  } else {
    return wrapToWidth(text, contentWidth);
  }
}

/**
 * Format pending markdown buffer for display.
 * Returns the formatted pending text, or '' if conditions prevent rendering.
 */
export function formatPendingBuffer(
  buffer: string,
  contentWidth: number,
  shouldRender: boolean,
): string {
  if (!shouldRender || !buffer.trim()) {
    return '';
  }

  let pendingRender: string;

  if (isInOpenCodeFence(buffer)) {
    pendingRender = '\n▍ streaming code…\n';
  } else if (isInOpenTable(buffer)) {
    // A streaming table has no internal blank line, so the whole (growing)
    // table stays in the pending buffer until a trailing blank line commits
    // it. Painting that growing table into the live overlay every chunk leaves
    // ghost rows once it exceeds the viewport height — so substitute a
    // fixed-height placeholder here, exactly as the open-code-fence path does.
    // The full table still renders once at commit via formatBlockForCommit.
    pendingRender = '\n▍ streaming table…\n';
  } else {
    pendingRender = renderTextBlock(buffer, contentWidth);
  }

  return wrapToWidth(pendingRender, contentWidth);
}

/**
 * Apply indentation to each line of text.
 * Empty lines are not indented (preserve blank line semantics).
 */
export function applyIndent(text: string, indentStr: string): string {
  return text
    .split('\n')
    .map((line) => (line ? indentStr + line : ''))
    .join('\n');
}

/**
 * Format a completed block for commit.
 * Renders markdown, wraps to content width, applies indentation, and trims excess whitespace.
 * Returns the formatted block text ready for display.
 */
export function formatBlockForCommit(
  blockText: string,
  indentStr: string,
  contentWidth: number,
): string {
  const rendered = renderTextBlock(blockText, contentWidth);

  // Wrap rendered content to contentWidth BEFORE adding indent. This
  // enforces width on prose that renderMarkdownToTerminal didn't hard-wrap,
  // while leaving table/code lines untouched (they already fit contentWidth).
  // Wrapping after indent (to contentWidth) would re-split structural lines
  // like table borders mid-row.
  const wrapped = wrapToWidth(rendered, contentWidth);
  const indented = applyIndent(wrapped, indentStr);
  // Strip BOTH leading and trailing blank lines. The caller (`commitBlock`)
  // re-adds exactly one trailing blank via `commitAbove(trimmed + '\n\n')`, so
  // a committed block must own neither — that is the TUI rhythm contract
  // (docs/tui-rhythm.md: "every block owns one trailing blank, no emitter owns
  // leading blanks"). Leading blanks reach here when a model emits 3+ newlines
  // between sections: the streamer splits on the first '\n\n', leaving the
  // surplus newline at the START of the next block. Without this strip it
  // survives as a double blank in scrollback.
  const trimmed = indented.replace(/^\n+/, '').replace(/\n+$/, '');

  return trimmed;
}

/**
 * Detect if buffer contains markdown-like content.
 * Fast-path: if no markdown markers detected, treat as plain text.
 */
export function hasMarkdownContent(text: string): boolean {
  // Check for common markdown markers, including ordered-list prefixes (e.g. "1. ")
  const hasMarkers = /[#*_\-\`>\[\|~]|\d+\.\s/.test(text);
  return hasMarkers;
}

/**
 * Detect if we're in the middle of a fenced code block (unclosed fence).
 *
 * Rules:
 * - Count only line-anchored fences (`^``` ` or `^~~~`) to avoid flipping
 *   parity on inline backtick sequences (e.g. regex literals in code, prose
 *   mentioning fences).
 * - ``` and ~~~ are independent fence families: each has its own parity check
 *   so a ~~~ opener is not closed by a ``` closer.
 * - Language tags (e.g. ```TypeScript, ```C++, ```YAML) are matched by
 *   allowing any non-newline characters after the fence marker.
 */
export function isInOpenCodeFence(text: string): boolean {
  // Line-anchored backtick fences (any language tag — not just lowercase alpha)
  const backtickFences = (text.match(/^```[^\n]*$/gm) ?? []).length;
  // Line-anchored tilde fences (any language tag)
  const tildeFences = (text.match(/^~~~[^\n]*$/gm) ?? []).length;
  // Odd count for either family means an unclosed fence
  return backtickFences % 2 === 1 || tildeFences % 2 === 1;
}

/**
 * Detect whether the pending buffer contains an in-progress GFM table,
 * identified by its delimiter row (e.g. `|---|:--:|`) — a line composed only
 * of pipes, dashes, optional alignment colons, and spaces.
 *
 * Mirrors {@link isInOpenCodeFence}: when this is true, `formatPendingBuffer`
 * renders a compact placeholder instead of the growing table, because a table
 * taller than the viewport leaves un-clearable ghost rows in the live overlay
 * (the absolute-cursor erase in CupFrameRenderer cannot reclaim rows that have
 * scrolled past the top of the viewport into scrollback).
 *
 * Requiring BOTH a pipe and a dash excludes horizontal rules (`---`, no pipe),
 * setext underlines, and prose lines that merely contain a stray pipe.
 */
export function isInOpenTable(text: string): boolean {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (
      line.length >= 3 &&
      line.includes('|') &&
      line.includes('-') &&
      /^[|:\- ]+$/.test(line)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Find the next block boundary in the buffer.
 * Returns the index of the character immediately after the boundary,
 * or -1 if no boundary found.
 */
export function findBlockBoundary(text: string): number {
  // Check for double newline (paragraph break), but only when NOT inside an
  // open code fence — a blank line inside a fenced block must not split it.
  const doubleNewlineIdx = text.indexOf('\n\n');
  if (doubleNewlineIdx !== -1) {
    // Guard: if the \n\n falls inside an unclosed fence, defer the boundary.
    if (!isInOpenCodeFence(text.slice(0, doubleNewlineIdx))) {
      return doubleNewlineIdx + 2; // Include both newlines
    }
  }

  // Check for closing fenced code fence (``` or ~~~ on its own line)
  // Pattern: newline, optional spaces, fence marker, optional spaces, newline
  const closeCodeFenceMatch = text.match(/\n[ \t]*(?:```|~~~)[ \t]*\n/);
  if (closeCodeFenceMatch && closeCodeFenceMatch.index !== undefined) {
    return closeCodeFenceMatch.index + closeCodeFenceMatch[0].length;
  }

  return -1;
}

/**
 * Initialize and wrap a log-update function for TTY output.
 * Returns a wrapped function with a clear() method, or null if import fails.
 *
 * Lazy-loaded to avoid unnecessary dependency on log-update module.
 */
export async function initLogUpdateModule(): Promise<{ (str: string): void; clear: () => void } | null> {
  try {
    const mod = await import('log-update');
    const logUpdateFn = (mod.default as unknown as { (str: string): void; clear: () => void });
    // Create wrapper that preserves clear method
    const wrapped: { (str: string): void; clear: () => void } = ((str: string) => {
      logUpdateFn(str);
    }) as any;
    wrapped.clear = () => logUpdateFn.clear();
    return wrapped;
  } catch {
    return null;
  }
}

/**
 * Parameters for routing overlay output to the appropriate sink.
 */
export interface OverlayRoutingParams {
  indented: string;
  overlayComposer: { markDirty(slot: string): void; flush(): void } | null | undefined;
  compositor: { setOverlay(str: string): void } | null;
  logUpdate: { (str: string): void; clear: () => void } | null;
}

/**
 * Route pending markdown output to the appropriate display channel.
 * Returns true if handled by composer/compositor, false if caller should
 * handle logUpdate path.
 */
export function routeOverlayOutput(params: OverlayRoutingParams): boolean {
  if (params.overlayComposer) {
    params.overlayComposer.markDirty('markdown-pending');
    params.overlayComposer.flush();
    return true;
  }
  if (params.compositor) {
    params.compositor.setOverlay(params.indented);
    return true;
  }
  return false;
}

/**
 * Accumulate a trimmed block into the committed output buffer.
 * Handles separator insertion between blocks.
 */
export function accumulateCommitted(current: string, trimmed: string): string {
  return current ? current + '\n\n' + trimmed : trimmed;
}

/**
 * Schedule a callback with throttling. Clears any pending timeout and sets
 * a new one for the specified delay. Returns the new timeout ID.
 */
export function scheduleWithThrottle(
  callback: () => void,
  throttleMs: number,
  currentTimer: NodeJS.Timeout | null,
): NodeJS.Timeout {
  if (currentTimer) {
    clearTimeout(currentTimer);
  }
  return setTimeout(callback, throttleMs);
}
