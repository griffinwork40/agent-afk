/**
 * Plain-English caveats for a verify run that did not measure everything it
 * set out to: failed episodes, ungraded outputs, and a budget stop. Each is
 * otherwise invisible in the rates, which silently shrink to the survivors.
 *
 * Also surfaces the hook-isolation note (context-injecting hooks disabled in
 * episodes) and a first-user-message diff warning when arms diverged despite
 * the isolation, so the operator knows the delta may be confounded.
 *
 * @module whatif/run.limits
 */

import type { VerifyResult } from './types.js';
import type { StructuralImpact } from './types.js';

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

/**
 * Returns the standard hook-isolation limit bullet (always included in
 * verified runs, unless the operator opted in to keeping context hooks).
 * Pass `keepContextHooks` = true when AFK_WHATIF_KEEP_CONTEXT_HOOKS was set.
 */
export function hookIsolationLimits(opts: {
  keepContextHooks: boolean;
  structural: Pick<StructuralImpact, 'userMessageDiff'>;
}): string[] {
  const out: string[] = [];
  if (!opts.keepContextHooks) {
    out.push(
      'SessionStart and UserPromptSubmit hooks were disabled in episodes so both arms ' +
        'see identical first user messages (set AFK_WHATIF_KEEP_CONTEXT_HOOKS=1 to keep them).',
    );
  }
  if (opts.structural.userMessageDiff && opts.structural.userMessageDiff.trim().length > 0) {
    out.push(
      'The first user message still differed between arms — injected context may confound the measured delta.',
    );
  }
  return out;
}
