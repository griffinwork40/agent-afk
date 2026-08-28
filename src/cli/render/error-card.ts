import { drawBox } from './box.js';
import { palette } from '../palette.js';

// ─── Error Card ──────────────────────────────────────────────────────────────

/**
 * Render a structured error card with an optional recovery hint and/or stack
 * trace.
 *
 * Visual output (hint only):
 *   ╭─ ERROR ──────────────────────────────╮
 *   │  Rate limit exceeded (429)           │
 *   │                                      │
 *   │  Retrying in 12s…                    │
 *   ╰─────────────────────────────────────╯
 *
 * Visual output (hint + stack):
 *   ╭─ ERROR ──────────────────────────────╮
 *   │  Unexpected error                    │
 *   │                                      │
 *   │  Try restarting the session          │
 *   │                                      │
 *   │  at foo (bar.ts:10:5)               │
 *   │  at baz (qux.ts:20:3)               │
 *   ╰─────────────────────────────────────╯
 *
 * Replaces the retired `errorBox()` with a richer, consistent format.
 * The hint line (dim, italic) surfaces recovery guidance directly in the
 * error card — reducing the "red box then silence" failure mode.
 * The stack field (dim, monospace-like) renders raw stack traces separately
 * from human-readable recovery hints.
 *
 * @param spec - Error card configuration.
 * @returns Multi-line ANSI string.
 */
export function errorCard(spec: ErrorCardSpec): string {
  const title = spec.title ?? 'ERROR';

  const bodyLines = Array.isArray(spec.body) ? spec.body : [spec.body];
  const content: string[] = [...bodyLines];

  if (spec.hint) {
    content.push('');
    content.push(palette.dim(palette.italic(spec.hint)));
  }

  if (spec.stack) {
    content.push('');
    for (const line of spec.stack.split('\n')) {
      content.push(palette.dim(line));
    }
  }

  return drawBox(content, {
    border: palette.error,
    title,
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ErrorCardSpec {
  /** Title chip in the top border (default: "ERROR"). */
  title?: string;
  /** Error body — one string per line, or a single string. */
  body: string | string[];
  /** Optional recovery hint — rendered dim/italic below the body. */
  hint?: string;
  /**
   * Optional raw stack trace — rendered dim below the hint (or body when no
   * hint is present). Structurally separate from `hint` so callers never mix
   * machine-readable stack frames with human-readable recovery messages.
   */
  stack?: string;
}
