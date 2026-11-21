/**
 * Turn-end closing of announced tool calls (profile §4, §7).
 *
 * Invariant: when a prompt turn ends (normal end, cancellation that outlasts
 * the grace window, or an error), every tool call the client was shown that
 * has not reached `completed` or `failed` gets exactly one terminal
 * `tool_call_update` with status `failed`, sent before the `session/prompt`
 * response. A real result or diff that arrives for such a call afterwards is
 * suppressed by the translator ({@link isClosedByTurnEnd}).
 *
 * Kept apart from acp.translate.ts so the prompt-turn path does not depend on
 * a new export of that module (several suites replace it with a test double).
 *
 * @module cli/commands/acp.translate.terminal
 */

import type { SessionUpdate, TranslatorState } from './acp.wire.js';

const closedByTurnEnd = Symbol('acp.closedByTurnEnd');
type ClosingState = TranslatorState & { [closedByTurnEnd]?: Set<string> };

export const TURN_ENDED_TEXT = 'Turn ended before the tool call finished';

/**
 * Record what the client was actually shown: a sent start announces the call,
 * a sent terminal status settles it. Keeps closing correct even when an update
 * reached the client without passing through the translator's own state.
 */
export function observeSentUpdate(st: TranslatorState, update: SessionUpdate): void {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
  const status = update.status;
  const known = st.tools.get(update.toolCallId);
  if (known === undefined) {
    if (update.sessionUpdate !== 'tool_call') return;
    st.tools.set(update.toolCallId, { name: update.name ?? '', announced: true, content: [], status: status ?? 'pending' });
    return;
  }
  if (update.sessionUpdate === 'tool_call') known.announced = true;
  if (status === 'completed' || status === 'failed') known.status = status;
}

/** True when the call was closed by {@link closeOpenToolCalls}; later results are dropped. */
export function isClosedByTurnEnd(st: TranslatorState, toolCallId: string): boolean {
  return (st as ClosingState)[closedByTurnEnd]?.has(toolCallId) === true;
}

/**
 * Mark every announced, non-terminal call failed and return one update per
 * call. Each turn closes all of its calls, so any open call belongs to the
 * turn now ending. A call that is already terminal is left untouched.
 */
export function closeOpenToolCalls(st: TranslatorState): SessionUpdate[] {
  const updates: SessionUpdate[] = [];
  for (const [toolCallId, tool] of st.tools) {
    if (!tool.announced || tool.status === 'completed' || tool.status === 'failed') continue;
    tool.status = 'failed';
    tool.content = [...tool.content, { type: 'content', content: { type: 'text', text: TURN_ENDED_TEXT } }];
    const local = st as ClosingState;
    (local[closedByTurnEnd] ??= new Set()).add(toolCallId);
    updates.push({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [...tool.content] });
  }
  return updates;
}
