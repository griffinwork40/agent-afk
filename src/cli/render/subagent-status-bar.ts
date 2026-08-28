import { displayWidth, truncateDisplayWidth } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { palette } from '../palette.js';

// ─── Subagent Status Bar ─────────────────────────────────────────────────────

/**
 * Render a single-line status bar for an active subagent dispatch.
 *
 * Visual output:
 *   ◉ research-agent  ── thinking…  3.2s  ∥2/4
 *
 * Designed for the OverlayComposer live region — called on every repaint
 * tick while the subagent is running, then removed on completion.
 *
 * @param spec - Status bar configuration.
 * @returns Single-line ANSI string.
 */
export function subagentStatusBar(spec: SubagentStatusBarSpec): string {
  const width = Math.min(getTerminalWidth(), 120);

  // ── Left: glyph + label ──
  // Truncate the label so the assembled row does not exceed `width`. Reserve
  // space for: glyph(1) + space(1) + separator gap(2) + elapsed(≤5) = 9 chars
  // minimum, plus optional phase and batch. We compute a conservative label
  // budget first, then clamp.
  const glyphWidth = 1; // '◉'
  const elapsedPlain = formatElapsed(spec.elapsedMs);
  const phasePlainRaw = spec.phase ?? '';
  const batchPlainRaw =
    spec.batchIndex != null && spec.batchSize != null
      ? `∥${spec.batchIndex}/${spec.batchSize}`
      : '';
  const fixedOtherWidth =
    glyphWidth +
    1 + // space after glyph
    2 + // gap between label and fill/phase
    (phasePlainRaw ? displayWidth(phasePlainRaw) + 2 : 0) +
    displayWidth(elapsedPlain) +
    (batchPlainRaw ? 2 + displayWidth(batchPlainRaw) : 0);
  const labelBudget = Math.max(3, width - fixedOtherWidth);
  const labelRaw = truncateDisplayWidth(spec.label, labelBudget);

  const glyph = palette.chrome('◉');
  const label = palette.tool(labelRaw);
  const left = `${glyph} ${label}`;
  const leftPlain = `◉ ${labelRaw}`;

  // ── Center: phase + elapsed ──
  const elapsed = elapsedPlain;
  const phase = phasePlainRaw ? palette.dim(phasePlainRaw) : '';
  const phasePlain = phasePlainRaw;

  // ── Right: batch badge (optional) ──
  const batch = batchPlainRaw ? palette.dim(batchPlainRaw) : '';
  const batchPlain = batchPlainRaw;

  // ── Assemble with fill ──
  const fixedWidth =
    displayWidth(leftPlain) +
    2 + // gap after label
    (phasePlain ? displayWidth(phasePlain) + 2 : 0) + // phase + gap after phase (omitted when absent)
    displayWidth(elapsed) +
    (batchPlain ? 2 + displayWidth(batchPlain) : 0);

  const fillLen = Math.max(0, width - fixedWidth);
  const fill = palette.dim('─'.repeat(Math.min(fillLen, 20)));

  const parts = [left, fill, ...(phase ? [phase] : []), palette.dim(elapsed)];
  if (batch) parts.push(batch);

  return parts.join('  ');
}

/**
 * Render multiple subagent status bars stacked vertically.
 *
 * Caps at `maxLines` (default 3) — excess entries are summarized as
 * `… +N more running` to prevent overlay height overflow.
 *
 * @param entries - Active subagent specs.
 * @param maxLines - Maximum visible lines (default 3).
 * @returns Multi-line ANSI string (may be empty if no entries).
 */
export function subagentStatusStack(
  entries: SubagentStatusBarSpec[],
  maxLines: number = 3,
): string {
  if (entries.length === 0) return '';

  const hasOverflow = entries.length > maxLines;
  const visible = entries.slice(0, hasOverflow ? maxLines - 1 : maxLines);
  const overflow = entries.length - visible.length;

  const lines = visible.map((e) => subagentStatusBar(e));

  if (overflow > 0) {
    lines.push(palette.dim(`  … +${overflow} more running`));
  }

  return lines.join('\n');
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubagentStatusBarSpec {
  /** Display label — e.g. "research-agent", "Agent(review)". */
  label: string;
  /** Current phase — e.g. "thinking…", "writing…", "running bash". */
  phase?: string;
  /** Elapsed time in milliseconds since dispatch. */
  elapsedMs: number;
  /** 1-based batch index when running as part of a parallel wave. */
  batchIndex?: number;
  /** Total batch size. */
  batchSize?: number;
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
