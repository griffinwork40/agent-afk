/**
 * The "yield to user" contract for long-running tools.
 *
 * A yieldable tool stops early when the operator has typed a message while it
 * is running, and tells the model to end its turn so the queued message is
 * delivered. This exists because a top-level REPL message typed mid-turn is
 * delivered at END OF TURN, not between tool rounds (the root REPL's
 * `setBeforeNextRound` hook delivers peer messages only and never consumes
 * the human queue; see `cli/commands/interactive/loop-iteration.boundary.ts`),
 * so a tool that
 * merely returns early would leave the message stranded while the model keeps
 * working.
 *
 * Invariant: yield is ONLY for tools that are safe to stop and redo later
 * (polls, idempotent waits, elicitation pickers). A tool whose interruption
 * loses or corrupts work (bash mid-build, compose mid-wave) must NEVER be in
 * {@link YIELDABLE_TOOLS}; those need a separate "detach" contract (keep
 * running, deliver later). The dispatcher attaches `userAttention` to a tool's
 * handler context only when the tool is in this set, so a non-yieldable tool
 * cannot observe the predicate at all.
 *
 * @module agent/tools/user-yield
 */

/** Read-only view of whether the operator is waiting to be heard. */
export interface UserAttention {
  /** True when the operator has typed a message that is queued for delivery. */
  hasPendingUserMessage(): boolean;
}

/**
 * Tools that opt in to yielding. Literal names (not imported constants) keep
 * this module a dependency-free leaf; `user-yield.test.ts` pins them against
 * the real tool-name constants.
 */
export const YIELDABLE_TOOLS: ReadonlySet<string> = new Set(['wait_for', 'exit_plan_mode']);

export function isYieldableTool(name: string): boolean {
  return YIELDABLE_TOOLS.has(name);
}

/**
 * Adapt a late-bound predicate holder (e.g. `PlanExitControls`, whose
 * `hasPendingUserMessage` the REPL installs AFTER session construction) into a
 * {@link UserAttention}. The predicate is read on every call, never captured,
 * so post-construction wiring and resume-swap re-wiring are both honoured.
 * Returns `undefined` when there is no holder (subagents, headless surfaces).
 */
export function userAttentionFrom(
  holder: { hasPendingUserMessage?: () => boolean } | undefined,
): UserAttention | undefined {
  if (holder === undefined) return undefined;
  return { hasPendingUserMessage: () => holder.hasPendingUserMessage?.() === true };
}

/**
 * Safe predicate read: absent attention or a throwing predicate is "no
 * pending message" — a broken UI probe must never break a tool call.
 */
export function isUserWaiting(attention: UserAttention | undefined): boolean {
  if (attention === undefined) return false;
  try {
    return attention.hasPendingUserMessage();
  } catch {
    return false;
  }
}

const DEFAULT_LEAD = 'The user has a queued message waiting to be delivered.';

/**
 * The shared model-facing instruction a yielding tool returns. `retry` names
 * how to resume (e.g. "You can call exit_plan_mode again afterward.").
 */
export function yieldNotice(retry: string, lead: string = DEFAULT_LEAD): string {
  return `${lead} End your turn now so the message is delivered first. ${retry}`;
}
