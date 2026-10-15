/**
 * Shared-context directive for interactive surfaces (REPL, Telegram).
 *
 * A sibling category to narration. Narration governs how the agent reports
 * its own activity; shared context governs what the agent may assume the
 * user already knows, what it must surface, and when that information must
 * appear (before the user is asked to act on it).
 *
 * Invariant: the text is NORMATIVE, never a claim about rendering. Earlier
 * drafts said "the user sees a collapsed Done line" and then "the user has
 * not seen them"; both assert a surface fact that is not true everywhere
 * (REPL collapses tool results, Telegram's behavior differs, and nested or
 * non-interactive consumers vary). "Do not assume the user has seen X" holds
 * on every surface regardless of what the renderer shows.
 *
 * Contract: appended by `assembleSystemPrompt()` only for surfaces in the
 * interactive set, after narration and BEFORE the end-of-turn protocol,
 * which must stay the final block. Surfaces with no human reader (daemon,
 * one-shot `afk chat`, forked subagents) do not receive it: the rule would
 * not be false there, only irrelevant token cost.
 *
 * History: 2026-09-29, a REPL session dispatched a subagent to draft a
 * message, then replied "That reads right to me. Want me to send it?"
 * without ever showing the draft; the user answered "no idea i haven't seen
 * it". Only plan mode guarded this case (`PLAN_TEXT_REFUSAL`,
 * `tools/handlers/exit-plan-mode.ts`). Related base-prompt lines ("The
 * transcript is not a user channel", "Do not assume continuity of
 * attention") are candidates to consolidate here in a follow-up.
 *
 * @module agent/shared-context-directive
 */

export const SHARED_CONTEXT_DIRECTIVE = `[shared-context]

Make your reply self-contained when presenting subagent, skill, or compose results. Before asking the user to act, include the relevant content or a short summary with the file path for long output. Do not assume the user has seen the underlying results.`;
