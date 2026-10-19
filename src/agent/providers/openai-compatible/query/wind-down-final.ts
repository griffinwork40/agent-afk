/**
 * Final-answer settlement for an openai-compatible wind-down round.
 *
 * Wind-down rounds (tool-round cap, soft deadline, context pressure) keep the
 * SAME `tools` array the turn has been sending, so the request prefix stays
 * byte-identical and server-side prefix/prompt caches stay valid (chat
 * templates such as Qwen's render the tool schemas BEFORE the system prompt, so
 * a tools-less request diverges within the first few tokens and re-prefills
 * the whole conversation). The trade-off: with tools advertised the model can
 * still answer with a tool call — structured `tool_calls`, or raw markup in the
 * text on servers that leave it unparsed.
 *
 * The same behaviour applies on the Responses API wire (`wireMode === 'responses'`):
 * `turn-iteration.ts` passes `activeTools` to `buildResponsesRequestBody` on
 * wind-down rounds for the same prefix-cache reason, and the turn driver's
 * no-dispatch invariant covers both wires identically.
 *
 * Invariant: a wind-down round NEVER dispatches. The turn driver settles the
 * round through {@link windDownFinalText} and ends the loop; it never reaches
 * `dispatchAndAppend`, the only site that builds an assistant `tool_calls`
 * message, so history never gains an orphan tool call either.
 *
 * Refs #3963 (failure shape B: raw `<tool_call>` markup returned as the answer).
 *
 * @module agent/providers/openai-compatible/query/wind-down-final
 */

import { WIND_DOWN_NO_ANSWER_PLACEHOLDER } from '../../shared/tool-loop-cap.js';

// Preserve this module's public export while sharing one provider-neutral value.
export { WIND_DOWN_NO_ANSWER_PLACEHOLDER };

/**
 * Remove tool-call markup from model text. Pure; never throws.
 *
 * Tool-call markup shapes emitted as plain text by common open-weight chat
 * templates when the server does not parse them:
 *   - Hermes/Qwen:        `<tool_call>{...}</tool_call>`
 *   - Qwen3-Coder XML:    `<function=name><parameter=x>..</parameter></function>`
 *   - Mistral-style:      `[TOOL_CALLS][...]` (to end of text)
 * Unterminated blocks (the stream was capped mid-call) are removed to the end
 * of the text.
 *
 * Regexes are constructed inside the function (not as module-level singletons)
 * so their `lastIndex` state is never shared across calls — `/g` regexes are
 * stateful and a module-level instance would be fragile if the call site ever
 * changes from `replace()` to `exec()` or `test()`.
 */
export function stripToolCallMarkup(text: string): string {
  const patterns: RegExp[] = [
    /<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g,
    /<function=[^>]*>[\s\S]*?(?:<\/function>|$)/g,
    /<\/?tool_calls?>/g,
    /\[TOOL_CALLS\][\s\S]*$/g,
  ];
  let out = text;
  for (const pattern of patterns) out = out.replace(pattern, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The final answer for a wind-down round: the round's own text with tool-call
 * markup removed, or {@link WIND_DOWN_NO_ANSWER_PLACEHOLDER} when nothing is
 * left. Deliberately ignores text from earlier rounds — a planning sentence
 * ("Let me write the file...") from before the wind-down is not an answer.
 */
export function windDownFinalText(roundText: string): string {
  const cleaned = stripToolCallMarkup(roundText);
  return cleaned.length > 0 ? cleaned : WIND_DOWN_NO_ANSWER_PLACEHOLDER;
}
