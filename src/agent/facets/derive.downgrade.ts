/**
 * Downgrade-signal logic for deriveSessionFacet.
 *
 * Extracted from derive.ts to stay within the 350-code-line ceiling.
 * Re-exported via derive.ts is not needed — only derive.ts itself calls
 * checkDowngradeSignals.
 *
 * @module agent/facets/derive.downgrade
 */

import type { FacetOutcomeDowngradeReason } from './schema.js';
import type { TraceSignals } from './derive.trace.js';

/**
 * Null-equivalent values for the Deferred / Pending bullet in a Done block.
 * Agents commonly write "none", "n/a", "-", "nothing", etc. to indicate there
 * is truly nothing deferred. These must NOT trigger the `deferred_items`
 * downgrade signal. Matching is case-insensitive on the trimmed bullet value.
 *
 * Exported for tests.
 */
export const NULL_DEFERRED_VALUES = new Set([
  'none',
  'n/a',
  'na',
  'nothing',
  'nil',
  '-',
  '—',   // em-dash
  'n.a.',
  '(none)',
  '(n/a)',
]);

/**
 * Return true when a parsed "Deferred / pending" bullet value is semantically
 * empty — i.e. the agent explicitly stated there is nothing deferred using a
 * common null-equivalent marker. Handles optional trailing punctuation.
 */
function isNullDeferredValue(value: string): boolean {
  // Strip optional trailing punctuation before matching
  const normalized = value.trim().replace(/[.!?,]+$/, '').toLowerCase();
  return normalized.length === 0 || NULL_DEFERRED_VALUES.has(normalized);
}

/**
 * Check whether a self-reported `fully_achieved` should be downgraded to
 * `partially_achieved` based on corroborating signals (#2798). Returns the
 * first matching downgrade reason, or `undefined` when no signal fires.
 *
 * Evaluated in priority order (most reliable signal first):
 *   1. `deferred_items` — Done block has a non-empty "Deferred / pending"
 *      bullet that is not a null-equivalent marker ("none", "n/a", "-", etc.).
 *      The agent itself declared pending work.
 *   2. `no_corroborating_evidence` — Done with zero world mutations (no file
 *      writes, edits, commits, patch_apply calls, or external-effects bash)
 *      and no evidence bullet in the Done block. A pure-text Done with no
 *      observable side-effects is suspect.
 *   3. `compose_partial_nodes` — at least one compose call wound down partial
 *      (soft-deadline or tool-use-iteration cap) during the session.
 *   4. `budget_exceeded_closure` — trace closure reason was 'budget_exceeded'.
 *   5. `iteration_cap_closure` — trace closure reason was 'iteration_cap'.
 *   6. `truncated_closure` — trace closure reason was 'truncated'.
 *   7. `subagent_budget_exhaustion` — at least one subagent was wound down by
 *      its tool-round cap (stopReason === 'tool_use_loop_capped').
 *
 * Signals 4–7 require trace data plumbed via DeriveOptions.traceSignals;
 * when absent they are skipped (never treated as a downgrade).
 */
export function checkDowngradeSignals({
  parsedDeferred,
  parsedEvidence,
  filesWritten,
  filesEdited,
  commits,
  bashExternalEffects = 0,
  composePartialNodes,
  traceSignals,
}: {
  parsedDeferred: string | undefined;
  parsedEvidence: string | undefined;
  filesWritten: number;
  filesEdited: number;
  commits: number;
  /** Count of SUCCESSFUL bash calls matching BASH_EXTERNAL_RE (#3182). */
  bashExternalEffects?: number;
  composePartialNodes: number;
  traceSignals: TraceSignals | undefined;
}): FacetOutcomeDowngradeReason | undefined {
  // Signal 1: explicit deferred/pending items in the Done block.
  // "Deferred: none", "Deferred: n/a", "Deferred: -", etc. are null-equivalent
  // markers that must NOT fire the downgrade (#2798).
  if (
    parsedDeferred !== undefined &&
    parsedDeferred.trim().length > 0 &&
    !isNullDeferredValue(parsedDeferred)
  ) {
    return 'deferred_items';
  }

  // Signal 2: no corroborating world mutations and no evidence bullet.
  // patch_apply is folded into filesWritten. External-effects bash (git push,
  // gh pr create/merge, npm/pnpm publish) also corroborate (#3182).
  const hasMutation = filesWritten > 0 || filesEdited > 0 || commits > 0 || bashExternalEffects > 0;
  const hasEvidenceBullet = parsedEvidence !== undefined && parsedEvidence.trim().length > 0;
  if (!hasMutation && !hasEvidenceBullet) {
    return 'no_corroborating_evidence';
  }

  // Signal 3: compose partial nodes — some parallel work was cut short.
  if (composePartialNodes > 0) {
    return 'compose_partial_nodes';
  }

  // Signals 4–7: trace-backed signals. Only evaluated when trace data is
  // present; absent traceSignals means no trace was available and no signal
  // should fire — absence is never a downgrade.
  if (traceSignals !== undefined) {
    const { traceClosureReason, hasSubagentBudgetExhaustion } = traceSignals;

    // Signal 4: monetary budget ceiling hit.
    if (traceClosureReason === 'budget_exceeded') {
      return 'budget_exceeded_closure';
    }

    // Signal 5: tool-use round cap at the top level.
    if (traceClosureReason === 'iteration_cap') {
      return 'iteration_cap_closure';
    }

    // Signal 6: output-token ceiling cut off the last model turn.
    if (traceClosureReason === 'truncated') {
      return 'truncated_closure';
    }

    // Signal 7: at least one forked subagent was wound down by its tool-round cap.
    if (hasSubagentBudgetExhaustion) {
      return 'subagent_budget_exhaustion';
    }
  }

  return undefined;
}
