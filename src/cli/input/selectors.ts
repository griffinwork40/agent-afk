import { sanitizeSchemaString } from '../_lib/sanitize.js';
import { emitKeypressEventsImmediateEscape } from './emit-keypress.js';
import { palette } from '../palette.js';

// ---------------------------------------------------------------------------
// Interactive terminal selectors
//
// These replace the bare numeric text-entry prompts with arrow-key navigable
// list pickers when stdout/stdin are TTYs. Falls back gracefully when not a
// TTY (tests, pipes, daemon) — callers detect this via the returned `null`.
//
// Each selector owns its own raw-mode entry/exit and is invoked AFTER
// suspendInput() has already released the compositor's keypress listener, so
// they operate on an otherwise-quiet stdin.
// ---------------------------------------------------------------------------

/**
 * Arrow-key single-choice selector. Returns the 0-based index of the chosen
 * item, `:cancel` if the user pressed Escape, or `null` if stdin is not a TTY
 * (falls back to text entry).
 */
export async function renderSelector(
  choices: string[],
  _abortSignal: AbortSignal,
): Promise<number | ':cancel' | null> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return null;
  if (choices.length === 0) return null;

  const MAX_VISIBLE = 10;
  let cursor = 0;
  let scrollOffset = 0;

  function visibleSlice(): { start: number; end: number } {
    const start = scrollOffset;
    const end = Math.min(start + MAX_VISIBLE, choices.length);
    return { start, end };
  }

  function renderLines(): string[] {
    const { start, end } = visibleSlice();
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const label = sanitizeSchemaString(choices[i]!, 80);
      if (i === cursor) {
        lines.push(`  ${palette.bold('▶ ' + label)}`);
      } else {
        lines.push(`    ${palette.dim(label)}`);
      }
    }
    if (choices.length > MAX_VISIBLE) {
      const { end: e } = visibleSlice();
      lines.push(palette.dim(`    (${scrollOffset + 1}–${e} of ${choices.length}  ↑/↓ to scroll)`));
    } else {
      lines.push(palette.dim('    ↑/↓ navigate  Enter select  Esc cancel'));
    }
    return lines;
  }

  // Initial render — write lines fresh (no cursor-up on first paint)
  const initialLines = renderLines();
  process.stdout.write(initialLines.join('\n') + '\n');
  let renderedLineCount = initialLines.length;

  function repaint(): void {
    const lines = renderLines();
    process.stdout.write(`\x1b[${renderedLineCount}A\x1b[0J` + lines.join('\n') + '\n');
    renderedLineCount = lines.length;
  }

  return new Promise<number | ':cancel'>((resolve) => {
    process.stdin.setRawMode(true);
    // ESC is the cancel affordance here; fire it on the first press (small
    // sub-perception escapeCodeTimeout) instead of after readline's ~500ms
    // buffer. See emit-keypress.ts.
    emitKeypressEventsImmediateEscape(process.stdin);

    const onKeypress = (_char: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (!key) return;

      if (key.name === 'up' || key.sequence === '\x1b[A') {
        if (cursor > 0) {
          cursor--;
          if (cursor < scrollOffset) scrollOffset = cursor;
          repaint();
        }
      } else if (key.name === 'down' || key.sequence === '\x1b[B') {
        if (cursor < choices.length - 1) {
          cursor++;
          const { end } = visibleSlice();
          if (cursor >= end) scrollOffset++;
          repaint();
        }
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(cursor);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(':cancel');
      }
    };

    function cleanup(): void {
      process.stdin.removeListener('keypress', onKeypress);
      try { process.stdin.setRawMode(false); } catch { /* noop */ }
    }

    process.stdin.on('keypress', onKeypress);
  });
}

/**
 * Arrow-key multi-choice selector. Returns the array of selected 0-based
 * indices, `:cancel`, or `null` for non-TTY fallback.
 *
 * Space toggles selection, Enter confirms, Escape cancels.
 */
export async function renderMultiSelector(
  choices: string[],
  _abortSignal: AbortSignal,
): Promise<number[] | ':cancel' | null> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return null;
  if (choices.length === 0) return null;

  const MAX_VISIBLE = 10;
  let cursor = 0;
  let scrollOffset = 0;
  const selected = new Set<number>();

  function visibleSlice(): { start: number; end: number } {
    const start = scrollOffset;
    const end = Math.min(start + MAX_VISIBLE, choices.length);
    return { start, end };
  }

  function renderLines(): string[] {
    const { start, end } = visibleSlice();
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const label = sanitizeSchemaString(choices[i]!, 80);
      const tick = selected.has(i) ? palette.bold('✓') : palette.dim('○');
      const arrow = i === cursor ? palette.bold('▶') : ' ';
      lines.push(`  ${arrow} ${tick} ${i === cursor ? palette.bold(label) : palette.dim(label)}`);
    }
    if (choices.length > MAX_VISIBLE) {
      lines.push(palette.dim(`    (${scrollOffset + 1}–${end} of ${choices.length}  ↑/↓ scroll)`));
    }
    lines.push(palette.dim('    ↑/↓ navigate  Space toggle  Enter confirm  Esc cancel'));
    return lines;
  }

  // Initial render
  const initialLines = renderLines();
  process.stdout.write(initialLines.join('\n') + '\n');
  let renderedLineCount = initialLines.length;

  function repaint(): void {
    const lines = renderLines();
    process.stdout.write(`\x1b[${renderedLineCount}A\x1b[0J` + lines.join('\n') + '\n');
    renderedLineCount = lines.length;
  }

  return new Promise<number[] | ':cancel'>((resolve) => {
    process.stdin.setRawMode(true);
    // ESC is the cancel affordance here; fire it on the first press (small
    // sub-perception escapeCodeTimeout) instead of after readline's ~500ms
    // buffer. See emit-keypress.ts.
    emitKeypressEventsImmediateEscape(process.stdin);

    const onKeypress = (_char: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (!key) return;

      if (key.name === 'up' || key.sequence === '\x1b[A') {
        if (cursor > 0) {
          cursor--;
          if (cursor < scrollOffset) scrollOffset = cursor;
          repaint();
        }
      } else if (key.name === 'down' || key.sequence === '\x1b[B') {
        if (cursor < choices.length - 1) {
          cursor++;
          const { end } = visibleSlice();
          if (cursor >= end) scrollOffset++;
          repaint();
        }
      } else if (key.name === 'space') {
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        repaint();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve([...selected].sort((a, b) => a - b));
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(':cancel');
      }
    };

    function cleanup(): void {
      process.stdin.removeListener('keypress', onKeypress);
      try { process.stdin.setRawMode(false); } catch { /* noop */ }
    }

    process.stdin.on('keypress', onKeypress);
  });
}
