/**
 * Turn draining + sidecar persistence for web-owned sessions.
 *
 * Extracted from `session-owner.ts` (at the 350-line ceiling). The owner used
 * to drain each turn's events and discard them: the ledger and the message
 * journal were written as side effects, but no sidecar was, so a session
 * started from the dashboard never appeared in the REPL's `/resume`. Now each
 * COMPLETED turn is folded into the session's autosaver, same as the REPL.
 *
 * @module web-server/session-owner.autosave
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { AgentSession } from '../agent/session/agent-session.js';
import { extractUserContent, isPreamble } from '../agent/session/preamble-strip.js';
import { createTurnCollector, type SessionAutosaver } from '../cli/session-autosave.js';

/**
 * The `userInput` recorded for a turn: the prompt text itself, or for a skill
 * invocation (multi-block payload carrying `<command-name>` tags) the readable
 * `/<skill> <args>` form the REPL records for the same dispatch.
 */
export function webTurnLabel(content: string | ContentBlockParam[]): string {
  if (typeof content === 'string') return content;
  const text = content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
  return (isPreamble(text) ? extractUserContent(text) : undefined) ?? text;
}

/**
 * Run one turn to completion, then persist it. An interrupted or failed turn
 * (no `done` event, or a throw out of the stream) is not saved, matching the
 * REPL's `recordTurn` guard; a throw still propagates to the caller.
 */
export async function drainAndPersistTurn(
  session: AgentSession,
  content: string | ContentBlockParam[],
  autosaver: SessionAutosaver | undefined,
): Promise<void> {
  const collector = createTurnCollector();
  for await (const event of session.sendMessageStream(content)) collector.observe(event);
  const turn = collector.result();
  if (turn.completed && autosaver) {
    autosaver.saveTurn(webTurnLabel(content), turn.assistantText, turn.metadata, turn.toolEvents);
  }
}
