/**
 * Terminal-state gate — agent-layer home.
 *
 * Moved from `src/cli/commands/interactive/terminal-state-gate.ts` so the
 * session layer can register the gate on every top-level surface (REPL,
 * Telegram, daemon, one-shot chat), not only the REPL bootstrap.
 *
 * The original module at `src/cli/commands/interactive/terminal-state-gate.ts`
 * re-exports everything from here so existing importers remain unaffected.
 *
 * See the original module's JSDoc for the full design rationale.
 *
 * @module agent/terminal-state-gate
 */

import type { HookContext, HookDecision, HookHandler } from './hooks.js';
import type { PermissionMode } from './types/sdk-types.js';
import { debugLog } from '../utils/debug.js';

/**
 * Default per-session cap on injected corrections. Bounds the "re-prompts too
 * eagerly burns turns" risk the proposal names — after this many unbacked-`Done`
 * corrections in one session the gate goes quiet and lets the claim stand.
 */
export const DEFAULT_MAX_TERMINAL_STATE_INJECTIONS = 3;

/**
 * The correction injected into the next turn when a `Done` lands with no
 * corroborating evidence. Framework note, not user text.
 *
 * History: the original correction (pre-classifyDoneEvidence) fired on any
 * `Done` with zero successful write/edit/bash. `doneHasCorroboratingEvidence`
 * now returns false for TWO shapes: (a) no evidence tools at all (empty turn,
 * subagent-only coordinator, pure conversation), and (b) unverified code
 * changes. This correction only fires for shape (b) — code was modified but
 * no verification command succeeded afterward — because for shape (a) the
 * gate cannot prescribe a corrective action (the fix is to do the work, not
 * to verify it).
 */
export const TERMINAL_STATE_GATE_CORRECTION =
  '[terminal-state gate] The previous turn modified source files but ended in ' +
  '**Done** without running a verification step afterward (test, lint, or ' +
  'type-check). Before ending again, do ONE of:\n' +
  '  (a) run the relevant verification command and cite the result; or\n' +
  '  (b) if the work is not actually complete, correct the terminal state to ' +
  'Blocked or Asking with the accurate status.\n' +
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
  // Invariant: the injection budget (`injections`) is PROCESS-LIFETIME scoped,
  // not per-conversation. This counter is created once when the gate is
  // constructed and persists for the life of the process. `/clear` deliberately
  // does NOT reset this budget — the gate has no /clear hook, and none is wired.
  //
  // This is an intentional decision (issue #565), not an oversight. The gate's
  // "bounded corrections per session" contract is read as per-PROCESS here.
  let injections = 0;

  return (context: HookContext): HookDecision => {
    if (context.event !== 'Stop') return {};
    // Cheap gates first; config/mode reads before touching the verdict.
    if (!opts.isEnabled()) return {};
    if (opts.getPermissionMode() !== 'autonomous') return {};
    if (context.terminalState !== 'done') return {};
    // Fire ONLY when code was changed but not verified — the one shape where
    // the correction ("run a verification step") is actionable. Other shapes:
    //   - 'no-code-changes' → no code mutation, correction text is misleading
    //   - 'verified' → verification already ran, nothing to correct
    //   - undefined → surface didn't compute it; no signal to act on
    if (context.doneEvidenceClassification !== 'unverified') return {};
    // Loop-guard: bounded corrections per session. Once spent, let the Done
    // stand rather than re-injecting forever.
    if (injections >= cap) {
      debugLog(
        `[terminal-state gate] injection budget exhausted (cap=${cap}); ` +
          `letting unbacked Done stand (fail open)`,
        { sessionId: context.sessionId },
      );
      return {};
    }
    injections += 1;
    debugLog(
      `[terminal-state gate] injecting Done-evidence correction ` +
        `(${injections}/${cap})`,
      { sessionId: context.sessionId },
    );
    return { injectContext: TERMINAL_STATE_GATE_CORRECTION };
  };
}
