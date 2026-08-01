/**
 * Turn-footer line for the subscription quota.
 *
 * The status-line indicator (`quota-indicator.ts`) is AMBIENT — it lives in
 * peripheral vision on a row the eye skips. That is correct for a number you
 * want available but not intrusive, and wrong for the moment a rolling window is
 * about to cap the session: nobody reads the bottom row before firing off
 * another turn. This module owns the intrusive half of the same signal, printed
 * into the turn footer beside the context-usage line it deliberately mirrors
 * (`formatContextUsage`, turn-handler.ts).
 *
 * Two different threshold sets on purpose, and they are not a mistake:
 *
 *   - The indicator's tone escalates at 50% / 80%. Tone is free — it costs the
 *     reader nothing to have already gone amber by the time they look.
 *   - This footer line starts at 80%. A printed line costs attention every
 *     single turn, so it stays silent through the whole range where the ambient
 *     tone is sufficient, and speaks only once the cap is a live risk.
 *
 * Deliberately stateless, matching the context-usage line's documented cadence:
 * the footer already renders once per turn, so escalation is carried by
 * severity/colour rather than by cross-turn suppression. No tier memory means no
 * module-scope mutable state, no test-reset hazard, and no way to silently miss
 * a crossing.
 *
 * Pure and colour-free (the caller maps `tier` → palette role) so it is
 * unit-testable without a palette or a terminal.
 *
 * @module cli/quota-footer
 */

import { formatResetCountdown, type QuotaWindowState, type QuotaWindows } from './quota-indicator.js';

/**
 * Mirrors `ContextTier` minus its `normal` band — the quota footer has no
 * chatty middle tier, so the caller's tone mapping is the same expression:
 * `over`/`near` → error, `caution` → warning.
 */
export type QuotaUsageTier = 'quiet' | 'caution' | 'near' | 'over';

/**
 * Utilization at which each tier begins. Aligned with `formatContextUsage`'s
 * 80% / 95% / 100% ladder rather than the indicator's 50% / 80% tone ladder, so
 * the two FOOTER lines escalate in step with each other; see the module note.
 */
const CAUTION_AT = 0.8;
const NEAR_AT = 0.95;
const OVER_AT = 1.0;

function tierFor(utilization: number): QuotaUsageTier {
  if (utilization >= OVER_AT) return 'over';
  if (utilization >= NEAR_AT) return 'near';
  if (utilization >= CAUTION_AT) return 'caution';
  return 'quiet';
}

interface LabelledWindow {
  readonly label: string;
  readonly state: QuotaWindowState;
}

function labelledWindows(windows: QuotaWindows): LabelledWindow[] {
  const out: LabelledWindow[] = [];
  if (windows.fiveHour !== undefined) out.push({ label: '5h', state: windows.fiveHour });
  if (windows.sevenDay !== undefined) out.push({ label: '7d', state: windows.sevenDay });
  return out;
}

/**
 * Contract: the runtime only actually parks and resumes when BOTH conditions
 * hold — `autoResumeOnUsageLimit` is on (default true, see `query.ts`), and the
 * reset lands within the retry layer's wait ceiling. Past that ceiling the
 * layer surfaces the error instead of waiting (`retry-layer.ts`), which a hot
 * 7d window routinely trips. Promising auto-resume outside those conditions
 * tells an AFK user to walk away from a turn that is going to terminate.
 *
 * Held as a local copy rather than a runtime import: `retry-layer.ts` sits
 * behind the provider boundary, and importing a value from it here would drag
 * the provider graph into the REPL's render path. `quota-footer.test.ts`
 * imports the real constant and asserts the two agree, so drift fails a test
 * instead of silently re-breaking this copy.
 */
const AUTO_RESUME_MAX_LEAD_MS = 2 * 60 * 60 * 1000;

/**
 * What actually happens when the window caps — the promise, or the truth.
 *
 * An unknown deadline keeps the promise: with no `resetsAt` the retry layer
 * polls within its own budget rather than bailing early, so parking is still
 * the real behaviour.
 */
function capNote(state: QuotaWindowState, now: Date, autoResume: boolean): string {
  if (!autoResume) return 'turns stop at the cap — auto-resume is off';
  if (
    state.resetsAt !== undefined &&
    state.resetsAt.getTime() - now.getTime() > AUTO_RESUME_MAX_LEAD_MS
  ) {
    return 'turns stop at the cap — the reset is too far out to wait';
  }
  return 'AFK pauses and auto-resumes at the cap';
}

/** `resets in 1h20m`, or undefined when no usable deadline is known. */
function resetClause(state: QuotaWindowState, now: Date): string | undefined {
  if (state.resetsAt === undefined) return undefined;
  const msLeft = state.resetsAt.getTime() - now.getTime();
  // A non-positive deadline means the window already rolled over, so the
  // utilization beside it is stale too — say nothing rather than assert a
  // deadline that has passed.
  if (msLeft <= 0) return undefined;
  return `resets in ${formatResetCountdown(msLeft)}`;
}

/**
 * Map the quota windows to an escalating footer line + tier, so the REPL warns
 * *proactively* as a rolling window approaches its cap rather than only once a
 * 429 has already paused the turn.
 *
 * `text` is null below 80% (the ambient indicator covers that range on its own)
 * and whenever no window is known — the permanent state under API-key auth,
 * where the quota headers never arrive at all.
 *
 * Reports the BINDING (highest-utilization) window, and appends the other only
 * when it has also cleared the caution bar — otherwise a hot 5h window would
 * imply the 7d budget is fine when it might be at 99%.
 */
export function formatQuotaUsage(
  windows: QuotaWindows | undefined,
  now: Date = new Date(),
  opts: { autoResume?: boolean } = {},
): { tier: QuotaUsageTier; text: string | null } {
  if (windows === undefined) return { tier: 'quiet', text: null };
  const all = labelledWindows(windows);
  const binding = all.reduce<LabelledWindow | undefined>(
    (worst, w) => (worst === undefined || w.state.utilization > worst.state.utilization ? w : worst),
    undefined,
  );
  if (binding === undefined) return { tier: 'quiet', text: null };

  const tier = tierFor(binding.state.utilization);
  if (tier === 'quiet') return { tier, text: null };

  const percent = Math.round(binding.state.utilization * 100);
  const reset = resetClause(binding.state, now);
  const alsoHot = all
    .filter((w) => w !== binding && tierFor(w.state.utilization) !== 'quiet')
    .map((w) => `${w.label} ${Math.round(w.state.utilization * 100)}%`);

  const suffix = alsoHot.length > 0 ? ` (also ${alsoHot.join(', ')})` : '';
  // Grounded in the runtime's actual behaviour: a usage-limit 429 parks the turn
  // and resumes it after the reset (see usage-limit.ts), emitting
  // usage_limit_pause / usage_limit_resume phases — but ONLY within the bounds
  // capNote checks. Saying so turns an alarming line into an actionable one;
  // saying so when it is false walks the user away from a turn that will die.
  const parkNote = capNote(binding.state, now, opts.autoResume ?? true);

  if (tier === 'over') {
    const head = `  ${binding.label} quota exhausted`;
    return { tier, text: `${head}${reset === undefined ? '' : ` — ${reset}`} — ${parkNote}${suffix}` };
  }
  if (tier === 'near') {
    const head = `  ${binding.label} quota ${percent}% used`;
    return { tier, text: `${head}${reset === undefined ? '' : ` — ${reset}`} — ${parkNote}${suffix}` };
  }
  const head = `  ${binding.label} quota ${percent}% used`;
  return { tier, text: `${head}${reset === undefined ? '' : ` — ${reset}`}${suffix}` };
}
