/**
 * Reusable session-summary rendering components.
 *
 * Extracted from three hand-rolled sites that produced slight formatting
 * variations of the same cost+token and session-end-summary patterns:
 *   - src/cli/commands/interactive.ts (printSessionSummary)
 *   - src/cli/commands/interactive/turn-handler.footer.ts (printTurnFooter)
 *   - src/cli/commands/interactive/resume-swap.ts (resumingParts)
 *
 * Contract: both helpers are pure (no side-effects, no console.log) so they
 * are trivially unit-testable. Callers own the write call.
 */

import { palette } from '../palette.js';
import { formatCost, formatTokens, formatDuration } from '../format-utils.js';

/**
 * Returns a formatted cost + token fragment, e.g. "$0.42  ·  12.3k tokens".
 *
 * Segments are only included when the value is present and non-zero.
 * The returned string is NOT pre-colored — callers apply their own palette
 * treatment (e.g. `palette.dim(...)` or `palette.brand(...)`) since the
 * footer, resume line, and exit summary all use different color roles.
 * Returns an empty string when both values are absent or zero.
 */
export function costTokenLine({
  costUsd,
  tokens,
  separator = '  ·  ',
}: {
  costUsd?: number;
  tokens?: number;
  separator?: string;
}): string {
  const parts: string[] = [];
  if (costUsd !== undefined && costUsd > 0) parts.push(formatCost(costUsd));
  if (tokens !== undefined && tokens > 0) parts.push(formatTokens(tokens) + ' tokens');
  if (parts.length === 0) return '';
  return parts.join(separator);
}

export interface SessionSummarySpec {
  /** Number of completed turns in this session. */
  turns: number;
  costUsd?: number;
  tokens?: number;
  durationMs?: number;
  /** Model name, e.g. "claude-opus-4-5". When provided, Line 2 is rendered. */
  model?: string;
  /**
   * Worktree basename shown next to the model name.
   * Defaults to "none" when model is provided but worktree is absent.
   */
  worktree?: string;
  /**
   * Pre-trimmed output of `git diff --shortstat HEAD`, or empty string for
   * "no files changed". When absent the git-stat line is omitted entirely.
   */
  gitStat?: string;
  /**
   * Pre-formatted resume command string (e.g. from formatResumeCommand).
   * When present, the "Continue with:" line is rendered using palette.brand.
   */
  resumeCommand?: string;
}

/**
 * Returns an array of pre-coloured lines for the session-end summary block.
 *
 *   Line 1: turns [· duration] [· cost] [· tokens]
 *   Line 2: model · worktree           (when model is provided)
 *   Line 3: edits: <gitStat>           (when gitStat is provided)
 *   Line 4: Continue with: <cmd>       (when resumeCommand is provided)
 *
 * Lines for absent optional fields are omitted. Callers print each line and
 * follow with a trailing console.log('') for the blank separator.
 */
export function sessionSummary(spec: SessionSummarySpec): string[] {
  const { turns, costUsd, tokens, durationMs, model, worktree, gitStat, resumeCommand } = spec;
  const lines: string[] = [];

  // Line 1 — core stats
  const parts: string[] = [`${turns} turn${turns === 1 ? '' : 's'}`];
  if (durationMs !== undefined) parts.push(formatDuration(durationMs));
  if (costUsd !== undefined && costUsd > 0) parts.push(formatCost(costUsd));
  if (tokens !== undefined && tokens > 0) parts.push(formatTokens(tokens) + ' tokens');
  lines.push(palette.dim('  ' + parts.join(' · ')));

  // Line 2 — model + worktree
  if (model !== undefined) {
    const worktreeName = worktree ?? 'none';
    lines.push(palette.dim(`  model: ${model} · worktree: ${worktreeName}`));
  }

  // Line 3 — git diff --shortstat
  if (gitStat !== undefined) {
    lines.push(palette.dim(`  edits: ${gitStat || 'no files changed'}`));
  }

  // Line 4 — resume hint
  if (resumeCommand !== undefined) {
    lines.push(palette.dim('  Continue with: ') + palette.brand(resumeCommand));
  }

  return lines;
}
