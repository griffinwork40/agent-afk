import { drawBox } from './box.js';
import { palette } from '../palette.js';

// ─── Error Card ──────────────────────────────────────────────────────────────

/**
 * Render a structured error card with an optional recovery hint.
 *
 * Visual output:
 *   ╭─ ERROR ──────────────────────────────╮
 *   │  Rate limit exceeded (429)           │
 *   │                                      │
 *   │  Retrying in 12s…                    │
 *   ╰─────────────────────────────────────╯
 *
 * Replaces ad-hoc `errorBox()` callers with a richer, consistent format.
 * The hint line (dim, italic) surfaces recovery guidance directly in the
 * error card — reducing the "red box then silence" failure mode.
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
}
