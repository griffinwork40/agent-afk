import type { AgentConfig } from './types.js';

/** Conservative unattended-only defaults; interactive/shared provider defaults stay unchanged. */
export const DEFAULT_UNATTENDED_BUDGET_USD = 5;
export const DEFAULT_UNATTENDED_TOOL_ROUNDS = 100;

type Limits = Pick<AgentConfig, 'maxBudgetUsd' | 'maxToolUseIterations'>;

/** Explicit config wins, then environment, then finite daemon/Telegram defaults. */
export function resolveUnattendedLimits(
  rawRounds: string | undefined,
  rawBudget: string | undefined,
  explicit: Limits = {},
): Required<Limits> {
  return {
    maxToolUseIterations: explicit.maxToolUseIterations ?? unattendedRounds(rawRounds),
    maxBudgetUsd: explicit.maxBudgetUsd ?? unattendedBudget(rawBudget),
  };
}

function unattendedRounds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_UNATTENDED_TOOL_ROUNDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn('[afk] AFK_MAX_TOOL_USE_ITERATIONS is not finite — using unattended default (100 rounds).');
    return DEFAULT_UNATTENDED_TOOL_ROUNDS;
  }
  // -0 passes isFinite but is not a deliberate "unlimited" intent.
  // Treat it like any other non-positive value and warn rather than silently
  // granting unlimited rounds on a daemon session.
  if (Object.is(parsed, -0)) {
    console.warn('[afk] AFK_MAX_TOOL_USE_ITERATIONS is -0 — using unattended default (100 rounds).');
    return DEFAULT_UNATTENDED_TOOL_ROUNDS;
  }
  // Preserve the existing numeric <=0 environment escape hatch (unlimited).
  return parsed <= 0 ? 0 : Math.max(1, Math.floor(parsed));
}

function unattendedBudget(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_UNATTENDED_BUDGET_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // Never echo raw configuration: a misplaced credential must not enter logs.
    console.warn('[afk] AFK_MAX_BUDGET_USD is not a valid finite non-negative number — using unattended default ($5).');
    return DEFAULT_UNATTENDED_BUDGET_USD;
  }
  return parsed;
}
