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

import type { VerifyResult, ChangeSpec, VerifiedPrediction } from './types.js';
import type { StructuralImpact } from './types.js';
import { mde, nForMde, formatMde } from './mde.js';

/**
 * Returns true when the change spec directly targets hooks or plugins.
 *
 * When true, the harness automatically enables `AFK_WHATIF_KEEP_CONTEXT_HOOKS`
 * in both episode arms so that the hooks under test actually register and can
 * be observed.  Without this, both arms would run with context hooks suppressed
 * and the experiment would measure nothing.
 *
 * Detects:
 *   - `disable-plugin`  — removes a plugin and its hooks.json hooks.
 *   - `file` targeting `home:config/afk.config.json` — modifies the primary
 *     hook configuration file.
 *   - `file` targeting a path whose basename is `hooks.json` — modifies a
 *     plugin-contributed hooks manifest.
 */
export function specTargetsHooksOrPlugins(spec: ChangeSpec): boolean {
  for (const change of spec.changes) {
    if (change.kind === 'disable-plugin') return true;
    if (change.kind === 'file') {
      const p = change.path;
      // home:config/afk.config.json is the primary hook config location.
      if (p === 'home:config/afk.config.json') return true;
      // Any hooks.json file (plugin or user-defined hook manifests).
      const basename = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
      if (basename === 'hooks.json') return true;
    }
  }
  return false;
}

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

/** The policy-relevant MDE threshold (10pp). Shifts smaller than this are
 * practically undetectable with typical episode counts. */
const MDE_THRESHOLD = 0.10;

/**
 * Returns MDE limit bullets for predictions whose achieved MDE (based on the
 * actual episode count in each arm) exceeds {@link MDE_THRESHOLD} (10pp).
 *
 * Bullets are grouped by n so the output is concise even with many predictions.
 * Only fires when at least one prediction has MDE > 10pp.
 */
export function mdeLimits(predictions: readonly VerifiedPrediction[]): string[] {
  if (predictions.length === 0) return [];

  // Group predictions by per-arm episode count. Prefer the episode scope
  // (samples within one episode are not independent, #2404); fall back to the
  // score count for results written before #2403. Skip predictions with no
  // evidence (empty arm) or no observable outcome — an MDE there is noise.
  const byN = new Map<number, string[]>();
  for (const vp of predictions) {
    if (vp.verdict === 'unobservable') continue;
    const n = vp.scope
      ? Math.min(vp.scope.episodes.baseline.length, vp.scope.episodes.candidate.length)
      : Math.min(vp.rates.n.baseline, vp.rates.n.candidate);
    if (n <= 0) continue;
    const achievedMde = mde(n);
    if (achievedMde > MDE_THRESHOLD) {
      const ids = byN.get(n) ?? [];
      ids.push(vp.prediction.id);
      byN.set(n, ids);
    }
  }

  if (byN.size === 0) return [];

  const out: string[] = [];
  for (const [n, ids] of byN) {
    const achievedMde = mde(n);
    const needed = nForMde(MDE_THRESHOLD);
    const mdeStr = formatMde(achievedMde);
    const label =
      ids.length === 1 ? `prediction ${ids[0]}` : `${ids.length} predictions (${ids.join(', ')})`;
    out.push(
      `With ${n} episode(s) per arm, ${label} can only detect ~${mdeStr} shifts; ` +
        `to detect 10pp you need ~${needed} episodes/arm.`,
    );
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
