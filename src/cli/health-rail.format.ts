/**
 * Pure formatter for the session-health glance-rail.
 *
 * Produces a compact single-line summary of session vitals:
 *   `T3 · 2m14s · 12 calls · 2 subs · ctx 34%`
 *
 * Designed for a tmux-pane glance: the operator can look at any window and
 * immediately know if the session is productive (turns advancing, subs running),
 * stuck (elapsed high, 0 turns), or done (no subs, stable turn count).
 *
 * Pure and injectable: takes plain numbers rather than live registry references
 * so the formatter is unit-testable without a terminal or palette.
 *
 * @module cli/health-rail.format
 */

import { palette } from './palette.js';
import { truncateDisplayWidth } from './display.js';

export interface HealthRailFields {
  /** Completed turns in this session. */
  totalTurns: number;
  /** Wall-clock ms since session start. */
  elapsedMs: number;
  /** Total tool calls made across all completed turns in this session. */
  toolCalls: number;
  /** Number of currently-running background subagent jobs. */
  activeSubs: number;
  /** Context window fill ratio [0, 1]. */
  contextRatio: number;
}

/**
 * Format elapsed milliseconds as a compact human string.
 *
 * Uses concatenated units (no spaces) to keep it tight on a status row.
 * Examples: `5s`, `2m14s`, `1h3m`, `2d4h`.
 */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m${totalSec % 60}s`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) return `${totalHr}h${totalMin % 60}m`;
  const days = Math.floor(totalHr / 24);
  return `${days}d${totalHr % 24}h`;
}

/**
 * Render the health-rail line, truncated to `maxWidth` columns.
 *
 * Color scheme:
 *   - Turn counter: brand (blue) — session identity
 *   - Elapsed time: dim — background rhythm
 *   - Tool calls: chrome — activity signal
 *   - Active subs: info when > 0, dim when 0 — live work indicator
 *   - Context %: threshold-toned (chrome ≤ 50%, warning > 50%, error > 80%)
 *
 * All segments are separated by `·` in dim, matching the status line's
 * established visual language.
 */
export function formatHealthRail(fields: HealthRailFields, maxWidth: number): string {
  const { totalTurns, elapsedMs, toolCalls, activeSubs, contextRatio } = fields;

  const sep = palette.dim(' · ');

  const turnText = palette.brand(`T${totalTurns}`);
  const elapsedText = palette.dim(formatDuration(elapsedMs));
  const callsText = palette.chrome(`${toolCalls} calls`);

  const subsText =
    activeSubs > 0
      ? palette.info(`${activeSubs} subs`)
      : palette.dim('0 subs');

  const pct = Math.round(Math.max(0, Math.min(1, contextRatio)) * 100);
  const ctxTone =
    contextRatio > 0.8 ? palette.error : contextRatio > 0.5 ? palette.warning : palette.chrome;
  const ctxText = palette.dim('ctx ') + ctxTone(`${pct}%`);

  const line = [turnText, elapsedText, callsText, subsText, ctxText].join(sep);
  return truncateDisplayWidth('  ' + line, maxWidth);
}
