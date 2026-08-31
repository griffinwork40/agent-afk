/**
 * Session summary render helpers — shared cost/token line fragments.
 *
 * Extracted from the duplicated hand-rolled session-end summaries in:
 *   - src/cli/commands/interactive.ts          (printExitSummary)
 *   - src/cli/commands/interactive/turn-handler.footer.ts (printTurnFooter)
 *   - src/cli/commands/interactive/resume-swap.ts          (resume line)
 *   - src/cli/commands/chat.ts                             (turn summary)
 *
 * Design principles:
 *   - Pure: no color, no separator — callers own those concerns.
 *   - Returns `string[]` so callers can spread into their own parts arrays
 *     and join with their own separator string.
 */

import { formatCost, formatTokens } from '../format-utils.js';

// ─── CostTokenSpec ────────────────────────────────────────────────────────────

/**
 * Input spec for {@link costTokenParts}.
 */
export interface CostTokenSpec {
  /** Cost in USD. Omitted or `undefined` → cost fragment is skipped. */
  costUsd?: number;
  /**
   * Total token count (typically input + output tokens combined).
   * Omitted, `undefined`, or `0` → token fragment is skipped.
   */
  tokens?: number;
  /**
   * When `true`, include the cost fragment even when `costUsd` is exactly
   * zero (matching the `!== undefined` guard used by per-turn footers and
   * the chat command). When `false` (default), a zero cost is omitted,
   * matching the `> 0` guard used by session-end summaries and resume lines.
   */
  includeZeroCost?: boolean;
}

// ─── costTokenParts ───────────────────────────────────────────────────────────

/**
 * Return formatted string fragments for cost and token statistics.
 *
 * Pure — produces no color, no separator, and no surrounding whitespace.
 * Callers spread the result into their own `parts` array and join with
 * their preferred separator (e.g. `' · '` or `'  ·  '`).
 *
 * Fragment ordering:
 *   1. cost  (`$0.00`, `$0.0012`, `$1.23`) — when present
 *   2. tokens (`42 tokens`, `1.2k tokens`) — when present
 *
 * @example
 * // Session-end summary (zero cost omitted):
 * parts.push(...costTokenParts({ costUsd: ctx.stats.totalCostUsd, tokens: ctx.stats.totalTokens }));
 *
 * @example
 * // Per-turn footer (zero cost included when the field was present):
 * parts.push(...costTokenParts({ costUsd: meta.totalCostUsd, tokens: inTok + outTok, includeZeroCost: meta.totalCostUsd !== undefined }));
 *
 * @param spec - Cost/token values and rendering options.
 * @returns Array of zero, one, or two formatted strings.
 */
export function costTokenParts(spec: CostTokenSpec): string[] {
  const parts: string[] = [];

  const { costUsd, tokens, includeZeroCost = false } = spec;

  // Cost fragment — include when:
  //   • costUsd is a finite number, AND
  //   • either costUsd > 0 OR the caller explicitly allows zero
  if (costUsd !== undefined && Number.isFinite(costUsd)) {
    if (costUsd > 0 || includeZeroCost) {
      parts.push(formatCost(costUsd));
    }
  }

  // Token fragment — include when token count is a positive finite number
  const tokenCount = tokens ?? 0;
  if (Number.isFinite(tokenCount) && tokenCount > 0) {
    parts.push(formatTokens(tokenCount) + ' tokens');
  }

  return parts;
}
