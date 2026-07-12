/**
 * Plan-mode-exit state machine, extracted from {@link AgentSession}.
 *
 * Owns the small cluster of state that survives from a mid-turn model-callable
 * `exit_plan_mode` tool call to the post-turn REPL boundary: the pending
 * implement-turn seed, the captured pre-plan permission mode to restore, and
 * the transient Shift+Tab ring-gesture memory. Pure bookkeeping — all provider
 * / metadata I/O stays on the session, which calls
 * {@link PlanExitBridge.recordModeTransition} for the plan capture and drains
 * the seed via {@link PlanExitBridge.takeSeed}.
 *
 * Lives on the session (not the per-turn dispatcher) so it survives from the
 * mid-turn tool call to the post-turn REPL boundary.
 *
 * @module agent/session/plan-exit-bridge
 */

import type { PermissionMode } from '../types.js';

export class PlanExitBridge {
  /**
   * Pending plan-exit implement-turn queued by an approved `exit_plan_mode`
   * tool call. The REPL drains it with {@link takeSeed} after the current turn,
   * which atomically applies the deferred permission-mode flip and returns the
   * seed message. Stores both the message and the approved mode so the flip can
   * be deferred to the post-turn boundary — closing the mid-turn TOCTOU window.
   */
  private pendingSeed: { message: string; mode: PermissionMode } | undefined;

  /**
   * The permission mode the session was in immediately BEFORE entering plan
   * mode. Captured by {@link recordModeTransition} on the transition INTO
   * 'plan' (covering every entry path — `/plan`, free-text `/plan`, Shift+Tab)
   * and read by an approved plan-exit ({@link getPrePlanMode}) so the
   * implement-turn restores it instead of forcing 'default'. `undefined` until
   * the first plan-entry, and reset to `undefined` when the prior mode was
   * 'autonomous' (AFK is not restorable by a bare flip) so restore falls back
   * to 'default'.
   */
  private prePlanMode: PermissionMode | undefined;

  /**
   * Ring-gesture memory for the Shift+Tab permission cycle
   * (`default → plan → bypassPermissions`, see `cli/permission-mode-cycle.ts`).
   * `plan`'s only ring-predecessor is `default`, so cycling from a privileged
   * working mode (e.g. bypass) INTO plan necessarily passes through a TRANSIENT
   * `default` hop: bypass → default → plan. Without this,
   * {@link recordModeTransition} would capture that transient `default` as the
   * pre-plan mode and an approved exit would drop the user to `default` instead
   * of restoring their real working mode. So on a `<privileged> → default`
   * transition we stash the mode left behind here; the very next
   * `default → plan` transition restores it as the pre-plan mode. Cleared at
   * every turn boundary (see {@link clearModeBeforeDefault}) so it survives ONLY
   * an uninterrupted Shift+Tab gesture — a genuine rest in `default` (which
   * submits a turn) clears it, keeping the restore safe: it never escalates back
   * to bypass after the user actually worked in `default`.
   */
  private modeBeforeDefault: PermissionMode | undefined;

  /**
   * Record the plan bookkeeping for a permission-mode transition. Pure state
   * update — the caller applies the actual provider/metadata flip. `current` is
   * the live mode read BEFORE the flip.
   *
   * Captures the mode being LEFT on the transition INTO plan, so an approved
   * exit can restore it. Guards on the non-plan → plan edge only: a redundant
   * plan → plan flip must not overwrite the real pre-plan mode with 'plan'.
   * 'autonomous' (AFK) is reset to undefined — it carries dedicated enter/exit
   * machinery and is not safe to re-enter by a bare flip — so restore falls
   * back to 'default'.
   */
  recordModeTransition(mode: PermissionMode, current: PermissionMode | undefined): void {
    if (mode === 'plan') {
      if (current !== 'plan') {
        // Ring-gesture rescue: the Shift+Tab cycle reaches plan only via a
        // TRANSIENT `default` hop off a privileged mode (bypass → default → plan).
        // When we're entering plan FROM that transient default, restore the mode
        // stashed on the hop instead of the default itself. `modeBeforeDefault`
        // is turn-scoped, so this only fires for an uninterrupted gesture.
        const effectivePrev =
          current === 'default' && this.modeBeforeDefault !== undefined
            ? this.modeBeforeDefault
            : current;
        this.prePlanMode = effectivePrev === 'autonomous' ? undefined : effectivePrev;
      }
    } else if (mode === 'default') {
      // Stash the privileged mode being left so the NEXT `default → plan` press
      // in the same Shift+Tab gesture can see past this transient default. Only
      // privileged non-plan modes are worth restoring; default/plan are not.
      this.modeBeforeDefault =
        current !== 'default' && current !== 'plan' ? current : undefined;
    } else {
      // Landing on a concrete working mode (bypass / acceptEdits / …) ends any
      // in-flight ring gesture toward plan — drop the transient-default memory.
      this.modeBeforeDefault = undefined;
    }
  }

  /**
   * End any in-flight Shift+Tab ring gesture. Called at every turn boundary:
   * submitting a turn means the user actually RESTED in the current mode, so a
   * transient-default stash must not survive into a later `default → plan`
   * (which would wrongly restore bypass after real work in default).
   */
  clearModeBeforeDefault(): void {
    this.modeBeforeDefault = undefined;
  }

  /**
   * The permission mode the session was in immediately before entering plan
   * mode, or `undefined` if none was captured (never entered plan, or the prior
   * mode was 'autonomous'). An approved plan-exit restores this; callers fall
   * back to 'default' on `undefined`.
   */
  getPrePlanMode(): PermissionMode | undefined {
    return this.prePlanMode;
  }

  /** Queue the deferred implement-turn from an approved `exit_plan_mode` call. */
  requestImplementSeed(message: string, mode: PermissionMode): void {
    this.pendingSeed = { message, mode };
  }

  /**
   * Return and CLEAR the pending plan-exit seed, or `undefined` if none is
   * pending. Single-shot: a second call returns `undefined` until the next
   * approval. The caller applies the deferred permission-mode flip.
   */
  takeSeed(): { message: string; mode: PermissionMode } | undefined {
    const seed = this.pendingSeed;
    this.pendingSeed = undefined;
    return seed;
  }
}
