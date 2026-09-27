/**
 * Light-narration directive for interactive surfaces (REPL, Telegram).
 *
 * The framework base prompt says "Run the loop; do not narrate it." That is
 * the right default for surfaces nobody watches live (daemon, one-shot
 * `afk chat`, subagent threads): text between tool calls there is pure token
 * cost and noise in programmatically consumed output. On interactive
 * surfaces a human is often watching the turn unfold, and is frequently
 * showing it to someone non-technical; a one-line "what I'm doing and why"
 * before a tool batch makes the run legible.
 *
 * Contract: appended by `assembleSystemPrompt()` only for surfaces in the
 * interactive set, immediately BEFORE the end-of-turn protocol (which must
 * stay the final block). It explicitly names the base-prompt line it refines
 * so the model does not read the two as a conflict to be resolved in favour
 * of the base.
 *
 * History: A/B measured with `afk whatif` (2026-09-27, opus, 10 episodes/env,
 * this exact text appended at the tail of the prompt): text before the first
 * tool call went 0/10 -> 10/10 episodes, text between tool calls 2/10 -> 6/10,
 * about two ~120-char narration sentences per episode, equal run cost.
 * Details and caveats are in the PR that introduced this file.
 *
 * @module agent/narration-directive
 */

export const NARRATION_DIRECTIVE = `[narration: light]

This is an interactive session and a human may be watching the turn unfold. This refines "Run the loop; do not narrate it" above: narrate lightly. Before a batch of tool calls, write one short sentence saying what you are about to do and why. After a significant result, write one short sentence on what you learned. No play-by-play, and do not restate tool output.`;
