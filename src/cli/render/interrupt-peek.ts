import { truncateDisplayWidth } from '../display.js';
import { palette } from '../palette.js';

// ─── InterruptPeek ───────────────────────────────────────────────────────────

/**
 * Spec for the InterruptPeek compact overlay panel.
 *
 * Rendered when the user hits Ctrl+C during a subagent turn. Replaces the
 * single dim line in `formatInterruptAffordance` with a 2-3 line panel that
 * includes status, optional subagent context, and a hint.
 */
export interface InterruptPeekSpec {
  /** Interrupt phase — actively aborting vs. already stopped. */
  status: 'interrupting' | 'interrupted';
  /** Active subagent being interrupted (if available). */
  activeSubagent?: {
    /** Subagent display name. */
    name: string;
    /** Current tool the subagent is executing (omit if thinking). */
    currentTool?: string;
    /** Elapsed ms since subagent dispatch. */
    elapsed?: number;
  };
  /** Hint text shown dim on the last line. Defaults to "Ctrl+C again to exit". */
  hint?: string;
  /** Terminal width for padding. Defaults to 80. */
  width?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format elapsed milliseconds as a compact human string. */
function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Render a compact interrupt status panel (2-3 lines, no box frame).
 *
 * Visual output (with subagent):
 *   ⚠ interrupting…
 *   ▸ research-agent — bash (12s)
 *   Ctrl+C again to exit
 *
 * Visual output (fallback):
 *   ⚠ interrupted
 *   Ctrl+C again to exit
 *
 * Designed for the OverlayComposer `interrupt` slot.
 */
export function interruptPeek(spec: InterruptPeekSpec): string {
  const indent = '  ';
  const width = spec.width ?? 80;
  // Account for the 2-character indent when computing the usable content width.
  const contentWidth = Math.max(1, width - indent.length);
  const lines: string[] = [];

  // ── Line 1: warning glyph + status text ──
  const statusText =
    spec.status === 'interrupting' ? 'interrupting…' : 'interrupted';
  lines.push(
    indent + truncateDisplayWidth(palette.warning(`⚠ ${statusText}`), contentWidth),
  );

  // ── Line 2 (optional): subagent context ──
  if (spec.activeSubagent) {
    const { name, currentTool, elapsed } = spec.activeSubagent;
    const activity = currentTool ?? 'thinking';
    const elapsedPart =
      elapsed != null ? ` (${formatElapsed(elapsed)})` : '';
    const contextText = `▸ ${name} — ${activity}${elapsedPart}`;
    lines.push(
      indent + truncateDisplayWidth(palette.meta(contextText), contentWidth),
    );
  }

  // ── Line 3: hint ──
  const hintText = spec.hint ?? 'Ctrl+C again to exit';
  lines.push(
    indent + truncateDisplayWidth(palette.dim(hintText), contentWidth),
  );

  return lines.join('\n');
}
