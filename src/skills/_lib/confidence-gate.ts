/**
 * Confidence gate — decides whether a sub-agent output should be run through
 * /shadow-verify before its claims drive downstream work.
 *
 * Used by orchestrator skills (e.g. /diagnose) that receive sub-agent output
 * carrying contract-style epistemic fields. Returns a verify/skip decision
 * plus a short reason suitable for logs.
 *
 * Gate rules:
 *   - confidence < 0.5                → verify (low-confidence output)
 *   - non-empty coverage_gaps         → verify (sub-agent admits gaps)
 *   - boundary_flag set               → verify (hit epistemic boundary)
 *   - otherwise                       → skip
 *
 * @module skills/_lib/confidence-gate
 */

export interface GateInput {
  /** Numeric confidence in [0, 1]. Matches HypothesisSchema. */
  confidence: number;
  /** Things the sub-agent could not access or verify. */
  coverage_gaps?: string[];
  /** Set when the sub-agent hit an epistemic limit (timeout, tool denial, etc.). */
  boundary_flag?: string;
}

export interface GateDecision {
  verify: boolean;
  reason: string;
}

const LOW_CONFIDENCE_THRESHOLD = 0.5;

export function shouldAutoVerify(input: GateInput): GateDecision {
  if (input.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return {
      verify: true,
      reason: `low confidence (${input.confidence.toFixed(2)} < ${LOW_CONFIDENCE_THRESHOLD})`,
    };
  }

  if (input.boundary_flag && input.boundary_flag.length > 0) {
    return {
      verify: true,
      reason: `boundary flag set: ${input.boundary_flag}`,
    };
  }

  if (input.coverage_gaps && input.coverage_gaps.length > 0) {
    return {
      verify: true,
      reason: `coverage gap${input.coverage_gaps.length === 1 ? '' : 's'}: ${input.coverage_gaps.length} unresolved`,
    };
  }

  return {
    verify: false,
    reason: `confidence ${input.confidence.toFixed(2)} with no gaps or boundary`,
  };
}
