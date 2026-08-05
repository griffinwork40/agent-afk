import type { FailurePattern } from '../schemas.js';
import { resolveContract } from '../eval-run/contracts.js';
import { resolveReplayHandler } from '../eval-run/replay.js';

/** Describe exactly what `eval-run` proves for a generated eval-case pattern. */
export function describeEvalRunCoverage(patternId: FailurePattern): string {
  if (resolveReplayHandler(patternId)) {
    return '`afk improve eval-run` re-drives this recorded failure and tests neutralisation.';
  }
  if (resolveContract(patternId)) {
    return (
      '`afk improve eval-run` runs a narrower guardrail-presence contract; ' +
      'it does not prove this recorded failure is fixed.'
    );
  }
  return '`afk improve eval-run` reports `unsupported` (exit 3); this assertion is not enforced.';
}
