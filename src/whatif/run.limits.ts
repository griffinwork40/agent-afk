/**
 * Plain-English caveats for a verify run that did not measure everything it
 * set out to: failed episodes, ungraded outputs, and a budget stop. Each is
 * otherwise invisible in the rates, which silently shrink to the survivors.
 *
 * @module whatif/run.limits
 */

import type { VerifyResult } from './types.js';

export function verifyShortfallLimits(v: VerifyResult): string[] {
  const out: string[] = [];
  if (v.failedEpisodes > 0) {
    out.push(`${v.failedEpisodes} episode run(s) failed and were left out of every measurement.`);
  }
  if ((v.judgeFailures ?? 0) > 0) {
    out.push(`${v.judgeFailures} output(s) could not be graded by the ${v.judge.name} judge and were left out.`);
  }
  if (v.truncatedByBudget) {
    out.push('The run stopped early at the spending cap, so fewer episodes were measured than planned.');
  }
  return out;
}
