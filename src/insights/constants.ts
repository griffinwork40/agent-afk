/**
 * All tunable recommendation thresholds in one auditable location.
 *
 * Any change to these values changes the recommendation rules — edit here,
 * not scattered across rule functions. Tests reference these same constants
 * so threshold changes automatically exercise tests.
 *
 * @module insights/constants
 */

export const RECOMMENDATION_THRESHOLDS = {
  /** Minimum error rate (fraction) on a tool to fire the high-error-tool rule. */
  toolErrorRateMin: 0.2,

  /** Minimum call count before error rate rule fires (avoids 1/1 = 100% noise). */
  highErrorToolMinCalls: 5,

  /** Task success rate below this value triggers the failing-daemon-task rule. */
  daemonSuccessRateMin: 0.5,

  /** Number of budget_exceeded closures needed to fire the budget-capped rule. */
  budgetExceededSessionsMin: 5,

  /** Any overflow kill count ≥ this value triggers the overflow-kills rule. */
  overflowKillsMin: 1,

  /** Cost fraction on one model family to fire cost-concentration rule. */
  costConcentrationMax: 0.9,

  /**
   * Minimum total cost (USD) before the cost-concentration rule fires.
   * Avoids alerting on $0.01 total cost where concentration is meaningless.
   */
  costConcentrationMinCostUsd: 0.1,

  /** Overall daemon error rate above this value with ≥ minRunsForDaemonErrorRate
   *  runs triggers the high-avg-daemon-error rule. */
  highDaemonErrorRateMin: 0.3,

  /** Minimum daemon runs before the high-avg-daemon-error rule fires. */
  minRunsForDaemonErrorRate: 10,
} as const;
