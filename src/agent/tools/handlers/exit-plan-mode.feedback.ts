/**
 * Free-text revision feedback for the `exit_plan_mode` picker.
 *
 * The picker opts into the shared custom-answer affordance (`allowCustom`), so
 * the user can type what should change instead of only choosing "Keep planning".
 * A custom answer arrives as `{ value: null, custom_value: '<text>' }` on every
 * surface (REPL `agent-question.ts`, Telegram `elicitation-handler.choice.ts`).
 *
 * Invariant: typed text ALWAYS means "revise", never approval. It is detected
 * BEFORE the handler's keyword matcher, because a custom answer carries
 * `value: null`, which the matcher would read as `''` and fall through to the
 * approve branch (queueing an implementation turn the user never chose). Text
 * containing words like "bypass" or "Keep" must not be keyword-matched either.
 *
 * @module agent/tools/handlers/exit-plan-mode.feedback
 */

/** Feedback longer than this is truncated before it reaches the model. */
export const MAX_PLAN_FEEDBACK_CHARS = 4000;

/**
 * Classify the elicitation `content` of an accepted picker result.
 *
 * - `{ kind: 'none' }` — not a custom answer; the caller runs its choice matcher.
 * - `{ kind: 'empty' }` — a custom answer that was blank/whitespace; treat as
 *   "Keep planning" (still never approval).
 * - `{ kind: 'feedback', text }` — trimmed (and capped) revision feedback.
 */
export type PlanFeedback =
  | { kind: 'none' }
  | { kind: 'empty' }
  | { kind: 'feedback'; text: string };

export function readPlanFeedback(content: Record<string, unknown> | undefined): PlanFeedback {
  const raw = content?.['custom_value'];
  if (typeof raw !== 'string') return { kind: 'none' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'empty' };
  const text =
    trimmed.length > MAX_PLAN_FEEDBACK_CHARS
      ? `${trimmed.slice(0, MAX_PLAN_FEEDBACK_CHARS)}… [truncated]`
      : trimmed;
  return { kind: 'feedback', text };
}

/** Tool result returned to the model when the user typed revision feedback. */
export function planFeedbackResult(text: string): string {
  return (
    'User did not approve the plan and gave revision feedback:\n' +
    `<user_feedback>\n${text}\n</user_feedback>\n` +
    'Stay in plan mode. Revise the plan to address this feedback, write the full ' +
    'revised plan as visible text, then call exit_plan_mode again. Do not implement.'
  );
}
