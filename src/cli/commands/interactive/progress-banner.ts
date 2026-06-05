import type { SubagentCompleteInfo } from '../../../agent/default-hook-registry.js';
import type { ProgressEvent } from '../../../agent/types.js';
import { truncateDisplayWidth } from '../../display.js';
import { formatDuration, formatTokens } from '../../format-utils.js';
import { palette } from '../../palette.js';
import { styleForToolName } from '../../tool-category.js';

/**
 * Clamp a fully-styled ANSI string to the current terminal width (or the
 * provided `columns` override used in tests).  Leaves ANSI reset codes intact
 * so the caller's `palette.dim(…)` wrapper still closes correctly.
 *
 * Falls back to 80 columns when `process.stdout.columns` is undefined (e.g.
 * non-TTY pipes) and skips clamping when `columns` is explicitly `Infinity`.
 */
function clampToTerminal(line: string, columns?: number): string {
  const cols = columns ?? process.stdout.columns ?? 80;
  if (!Number.isFinite(cols) || cols <= 0) return line;
  return truncateDisplayWidth(line, cols);
}

/**
 * Render a progress event into one or two CLI lines.
 *
 * Line 0 is the task's stable description (invariant across ticks for a
 * given taskId). When a per-tick `summary` is present, a second indented
 * line carries the summary and the changing stats — keeping the per-tick
 * data on its own row so the description can be deduped on commit without
 * losing tool/token/duration progress. When no summary is available, stats
 * stay on the description line as a fallback.
 *
 * The whole banner is rendered dim. The `via {glyph} {ToolName}` segment
 * is colored by tool category so the kind of work currently happening
 * stands out against the otherwise muted line. Chalk's nested-restyle
 * preserves the outer dim across the inner color reset.
 *
 * Each returned line is clamped to the terminal width (or `columns` when
 * provided) so long descriptions and summaries never wrap onto a second row
 * and corrupt multi-line REPL layout.
 */
export function formatProgressBanner(event: ProgressEvent, columns?: number): string[] {
  const { description, summary, lastToolName, totalTokens, toolUses, durationMs } = event;
  const stats: string[] = [];

  if (lastToolName) {
    const { color, glyph } = styleForToolName(lastToolName);
    stats.push(`via ${color(`${glyph} ${lastToolName}`)}`);
  }
  if (toolUses) stats.push(`${toolUses} tool${toolUses === 1 ? '' : 's'}`);
  if (totalTokens) stats.push(`${formatTokens(totalTokens)} tok`);
  if (durationMs) stats.push(formatDuration(durationMs));
  stats.push('esc to interrupt · ctrl+b background');

  const statsStr = stats.length > 0 ? ` (${stats.join(' · ')})` : '';

  if (summary) {
    return [
      clampToTerminal(palette.dim(`  ◦ ${description}`), columns),
      clampToTerminal(palette.dim(`    ${summary}${statsStr}`), columns),
    ];
  }
  return [clampToTerminal(palette.dim(`  ◦ ${description}${statsStr}`), columns)];
}

/**
 * One-line summary committed to scrollback when a subagent task finishes.
 * Compact: just description + final stats on a single dim line.
 * The line is clamped to terminal width to prevent wrap-corruption in scrollback.
 */
export function formatProgressSummary(event: ProgressEvent, columns?: number): string {
  const { description, totalTokens, toolUses, durationMs } = event;
  const stats: string[] = [];
  if (toolUses) stats.push(`${toolUses} tool${toolUses === 1 ? '' : 's'}`);
  if (totalTokens) stats.push(`${formatTokens(totalTokens)} tok`);
  if (durationMs) stats.push(formatDuration(durationMs));
  const statsStr = stats.length > 0 ? ` (${stats.join(' · ')})` : '';
  return clampToTerminal(palette.dim(`  ◦ ${description}${statsStr}`), columns);
}

/**
 * One-line completion banner for a finished subagent.
 * Icon encodes terminal status; duration follows the agent label.
 * The line is clamped to terminal width so very long agent labels don't wrap.
 */
export function formatSubagentCompletion(info: SubagentCompleteInfo, columns?: number): string {
  const icon = info.status === 'succeeded' ? '✓' : info.status === 'failed' ? '✗' : '⊘';
  const label = info.agentType ?? info.subagentId;
  const parts = [icon, label];
  if (info.durationMs !== undefined) parts.push(`· ${formatDuration(info.durationMs)}`);
  return clampToTerminal(palette.dim(`  ${parts.join(' ')}`), columns);
}
