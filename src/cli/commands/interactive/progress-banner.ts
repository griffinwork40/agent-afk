import type { SubagentCompleteInfo } from '../../../agent/default-hook-registry.js';
import type { ProgressEvent } from '../../../agent/types.js';
import type { CompletionWriter } from './shared.js';
import { extractLatestThinkingClause } from '../../_lib/stream-renderer-subagent-helpers.js';
import { truncateDisplayWidth } from '../../display.js';
import { formatDuration, formatTokens, formatToolCallStat } from '../../format-utils.js';
import { palette } from '../../palette.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { styleForToolName } from '../../tool-category.js';
import { sanitizeLabel } from './tool-lane-format-sanitize.js';

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
 * Derive the grounded "current activity" clause for the progress banner from
 * the live thinking buffer — the in-flight thought the model is writing right
 * now (see {@link extractLatestThinkingClause} for the boundary heuristics).
 *
 * Callers pass `ThinkingLane.peekPhase()` (the CURRENT uncommitted phase, not
 * the cumulative buffer) so the activity clears once a phase is sealed at a
 * tool/prose boundary instead of re-showing reasoning already collapsed into
 * an inline "◆ thought for Xs" line. Returns `undefined` when the buffer holds
 * no usable clause, so the banner falls back to the event's own `summary`.
 *
 * The clause is NOT sanitized here — {@link formatProgressBanner} owns the
 * `sanitizeLabel` pass on every LLM-sourced field at render time, mirroring
 * the tool-lane convention (extract raw → sanitize at the render site).
 */
export function deriveProgressActivity(
  thinkingBuffer: string,
  columns?: number,
): string | undefined {
  if (!thinkingBuffer) return undefined;
  const cols = columns ?? getTerminalWidth();
  const clause = extractLatestThinkingClause(thinkingBuffer, Math.max(20, cols - 10));
  return clause || undefined;
}

/**
 * Format the live rate-limit / backoff banner activity clause.
 *
 * Contract: converts the provider's `rate_limit` signal into the short string
 * the progress banner shows WHILE the SDK sleeps out a `retry-after` backoff
 * (the session is healthy-but-waiting, not hung). `retryAfterMs` is rounded up
 * to whole seconds so a sub-second hint still reads `~1s` rather than `~0s`;
 * when the header carried no delay the copy drops the ETA. Pure and
 * side-effect-free so it is trivially unit-testable and safe to call at render
 * time.
 *
 *   70000  → `rate-limited · retrying in ~70s`
 *   500    → `rate-limited · retrying in ~1s`
 *   0      → `rate-limited · retrying…`   (no positive delay to show)
 *   undef  → `rate-limited · retrying…`
 */
export function formatRateLimitActivity(retryAfterMs?: number): string {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return 'rate-limited · retrying…';
  }
  // Round UP so a sub-second retry-after never displays `~0s`.
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `rate-limited · retrying in ~${seconds}s`;
}

/**
 * Render a progress event into one or two CLI lines.
 *
 * Line 0 is the task's stable description (invariant across ticks for a
 * given taskId). The second indented line carries the grounded per-tick
 * signal plus the changing stats: `activity` (the model's in-flight thinking
 * clause, when one is live) wins over the event's own `summary` (the
 * tool-derived headline) — the thought is the fresher intent signal, and the
 * `via {tool}` stat segment already names the tool. Keeping the per-tick data
 * on its own row lets the description be deduped on commit without losing
 * tool/token/duration progress. When neither is available, stats stay on the
 * description line as a fallback.
 *
 * Every LLM-sourced field (`description`, `summary`, `activity`) passes
 * through {@link sanitizeLabel} before composition — these strings originate
 * from model output (tool names/args, thinking text) and must not carry
 * ANSI/control bytes into the overlay (same injection surface the tool-lane
 * sanitizes at its render sites).
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
export function formatProgressBanner(
  event: ProgressEvent,
  columns?: number,
  activity?: string,
): string[] {
  const { description, summary, lastToolName, totalTokens, toolUses, durationMs } = event;
  const stats: string[] = [];

  if (lastToolName) {
    const { color, glyph } = styleForToolName(lastToolName);
    stats.push(`via ${color(`${glyph} ${sanitizeLabel(lastToolName)}`)}`);
  }
  if (toolUses) stats.push(formatToolCallStat(toolUses));
  if (totalTokens) stats.push(`${formatTokens(totalTokens)} tok`);
  if (durationMs) stats.push(formatDuration(durationMs));
  stats.push('esc to interrupt · ctrl+b background');

  const statsStr = stats.length > 0 ? ` (${stats.join(' · ')})` : '';

  const cleanDescription = sanitizeLabel(description);
  const detailRaw = activity?.trim() ? activity : summary;
  const detail = detailRaw ? sanitizeLabel(detailRaw) : '';

  if (detail) {
    return [
      clampToTerminal(palette.dim(`  ◦ ${cleanDescription}`), columns),
      clampToTerminal(palette.dim(`    ${detail}${statsStr}`), columns),
    ];
  }
  return [clampToTerminal(palette.dim(`  ◦ ${cleanDescription}${statsStr}`), columns)];
}

/**
 * One-line summary committed to scrollback when a subagent task finishes.
 * Compact: just description + final stats on a single dim line.
 * The line is clamped to terminal width to prevent wrap-corruption in scrollback.
 */
export function formatProgressSummary(event: ProgressEvent, columns?: number): string {
  const { description, totalTokens, toolUses, durationMs } = event;
  const stats: string[] = [];
  if (toolUses) stats.push(formatToolCallStat(toolUses));
  if (totalTokens) stats.push(`${formatTokens(totalTokens)} tok`);
  if (durationMs) stats.push(formatDuration(durationMs));
  const statsStr = stats.length > 0 ? ` (${stats.join(' · ')})` : '';
  return clampToTerminal(palette.dim(`  ◦ ${sanitizeLabel(description)}${statsStr}`), columns);
}

/**
 * One-line completion banner for a finished subagent.
 * Icon encodes terminal status; duration follows the agent label.
 * The line is clamped to terminal width so very long agent labels don't wrap.
 */
export function formatSubagentCompletion(info: SubagentCompleteInfo, columns?: number): string {
  const icon = info.status === 'succeeded' ? '✓' : info.status === 'failed' ? '✗' : '⊘';
  // agentType is model-influenceable (dispatch args) — same sanitize rule as
  // every other LLM-sourced label in this module.
  const label = sanitizeLabel(info.agentType ?? info.subagentId);
  const parts = [icon, label];
  if (info.durationMs !== undefined) parts.push(`· ${formatDuration(info.durationMs)}`);
  return clampToTerminal(palette.dim(`  ${parts.join(' ')}`), columns);
}

/**
 * Emit the REPL's SubagentStop completion line (Channel B) through the shared
 * {@link CompletionWriter}, unless the writer has flagged it suppressed for the
 * current foreground turn.
 *
 * History: the SubagentStop hook fires per subagent (any dispatch path —
 * parallel `agent` calls, `compose`/DAG nodes, skill children), independently
 * of the parent turn's SDK-event cadence. In the interactive REPL the ToolLane
 * (Channel A) already renders each foreground subagent as a `→ Agent(…) Done`
 * tree, so this compact line is a redundant SECOND representation — and because
 * it lands via an uncoordinated `commitAbove` while the OverlayComposer is
 * concurrently repainting a tall multi-root overlay, the two writers desync the
 * compositor's frame row-accounting (stacked ghost `◉` markers + committed
 * lines overwritten). Parallel dispatch (`compose`, devils-advocate) maximizes
 * the interleaving because sibling nodes finish on independent schedules.
 *
 * `suppressSubagentCompletion` is bracketed by turn-handler around exactly the
 * window a live overlay owns the surface, so between-turn background-job
 * completions and the non-TTY one-shot `chat` surface (which uses its own
 * console writer, not this callback) are unaffected. Extracted from the inline
 * bootstrap closure so the gate is unit-testable — see progress-banner.test.ts.
 */
export function emitSubagentCompletion(writer: CompletionWriter, info: SubagentCompleteInfo): void {
  if (writer.suppressSubagentCompletion) return;
  writer.fn(formatSubagentCompletion(info));
}
