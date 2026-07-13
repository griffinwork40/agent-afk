/**
 * Terminal-state gate — a post-turn `Stop` hook that makes the AFK terminal-state
 * contract *code-enforced* instead of prompt-only (issue #237).
 *
 * AFK's system prompt mandates every turn end in a named terminal state, but the
 * model grades its own homework: nothing stops it from declaring `Done` while a
 * blocker remains. In an unattended run that false "finished" is the most
 * expensive failure in the system — the operator is pinged a confident
 * completion, on their phone, away from the trace, and acts on one line.
 *
 * This gate reads the parsed verdict off {@link StopContext} (populated by the
 * REPL loop from `onTerminalState`) and, when a turn self-certifies `Done` with
 * NO corroborating evidence (no successful file write/edit or executed command —
 * see `doneHasCorroboratingEvidence` in `afk-push.ts`), returns an
 * `injectContext` correction. The loop stashes it and prepends it to the next
 * turn's prompt (the Stop `injectContext` primitive), so the next turn must
 * substantiate or downgrade the claim before the session seals.
 *
 * Scope (deliberately narrow — issue #237's tractable slice):
 *
 *   - **Only the unbacked-`Done` shape is enforced.** The proposal also names
 *     "needless `Asking`" and "unverified `Blocked`" as behavioral failures, but
 *     neither can be detected mechanically without unacceptable false-positive
 *     risk (we cannot know an `Asking` was needless, or a `Blocked` cause
 *     guessed). Those are left to prompt-level guidance. Extending this gate to
 *     a new shape means adding a signal the loop can compute, not a heuristic.
 *   - **Autonomous mode only.** In interactive mode a human is watching and can
 *     correct; bouncing the turn would be friction. Mirrors the `telegram.verifyDone`
 *     notification gate, which is also autonomous-only.
 *   - **Opt-in, default off.** Gated on the human-tier `enforceDoneEvidence`
 *     config key (a self-honesty check the agent must not disable on its own —
 *     same rationale as `telegram.verifyDone`).
 *   - **Loop-guarded.** Bounded corrections per session; once exhausted the gate
 *     lets the `Done` stand (fails open) rather than burning turns re-injecting.
 *
 * The gate NEVER blocks the turn and never throws — the worst case is one extra
 * framework note on the next prompt.
 *
 * @module cli/commands/interactive/terminal-state-gate
 */

import type { HookContext, HookDecision, HookHandler } from '../../../agent/hooks.js';
import type { PermissionMode } from '../../../agent/types/sdk-types.js';

/**
 * Default per-session cap on injected corrections. Bounds the "re-prompts too
 * eagerly burns turns" risk the proposal names — after this many unbacked-`Done`
 * corrections in one session the gate goes quiet and lets the claim stand.
 */
export const DEFAULT_MAX_TERMINAL_STATE_INJECTIONS = 3;

/**
 * The correction injected into the next turn when a `Done` lands with no
 * corroborating evidence. Framework note, not user text — it names the failure
 * shape and the two acceptable resolutions (substantiate or downgrade), and
 * explicitly forbids simply re-asserting `Done`.
 */
export const TERMINAL_STATE_GATE_CORRECTION =
  '[terminal-state gate] The previous turn ended in **Done**, but this turn ' +
  'recorded no corroborating evidence — no successful file write/edit or ' +
  'executed command. In AFK mode a `Done` with nothing behind it is the ' +
  'highest-cost failure: the operator is pinged "finished" and acts on it while ' +
  'away from the trace. Before ending again, do ONE of:\n' +
  '  (a) produce and cite the concrete artifact that backs the completion — the ' +
  'file written, the command run and its result, or the test that passed; or\n' +
  '  (b) if the work is not actually complete, correct the terminal state to ' +
  'Blocked or Asking with the accurate status and the real blocker/question.\n' +
  'Do not simply re-assert Done.';

export interface TerminalStateGateOptions {
  /**
   * Live permission-mode getter. The gate only fires in `'autonomous'` (AFK)
   * mode; in every other mode it is a no-op (a human is watching).
   */
  getPermissionMode: () => PermissionMode;
  /**
   * Live enable getter — reads the human-tier `enforceDoneEvidence` config on
   * every turn (so a mid-session config change takes effect without restart,
   * matching `telegram.verifyDone`'s fresh-read semantics). Default off.
   */
  isEnabled: () => boolean;
  /**
   * Per-session cap on injected corrections (loop-guard). Defaults to
   * {@link DEFAULT_MAX_TERMINAL_STATE_INJECTIONS}.
   */
  maxInjectionsPerSession?: number;
}

/**
 * Build the terminal-state gate hook handler. Register on the `'Stop'` event.
 *
 * Returns `{ injectContext }` only when ALL hold: the feature is enabled, the
 * session is in autonomous mode, the completed turn's verdict is `Done`, the
 * turn produced no corroborating evidence, and the per-session injection budget
 * is not exhausted. Otherwise returns `{}` (no-op — never blocks).
 */
export function createTerminalStateGate(opts: TerminalStateGateOptions): HookHandler {
  const cap = opts.maxInjectionsPerSession ?? DEFAULT_MAX_TERMINAL_STATE_INJECTIONS;
  let injections = 0;

  return (context: HookContext): HookDecision => {
    if (context.event !== 'Stop') return {};
    // Cheap gates first; config/mode reads before touching the verdict.
    if (!opts.isEnabled()) return {};
    if (opts.getPermissionMode() !== 'autonomous') return {};
    if (context.terminalState !== 'done') return {};
    // Fire ONLY on an explicit `false` — evidence computed and absent. `undefined`
    // (surface didn't compute it) and `true` (evidence present) both pass.
    if (context.doneHasCorroboratingEvidence !== false) return {};
    // Loop-guard: bounded corrections per session. Once spent, let the Done
    // stand rather than re-injecting forever.
    if (injections >= cap) return {};
    injections += 1;
    return { injectContext: TERMINAL_STATE_GATE_CORRECTION };
  };
}
