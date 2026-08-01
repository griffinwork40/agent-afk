/**
 * /retry — resubmit the last user message.
 *
 * Why this exists: when a Claude OAuth account runs out of usage quota
 * mid-turn, the API returns 429 and — on fail-fast paths, e.g. a subagent
 * fork hitting the limit — the turn dies before any assistant text is
 * committed to history. The conversation therefore still ends with the
 * operator's own last user message; nothing "replies" to it. Today the
 * operator has to retype something like "continue" to get the turn moving
 * again. `/retry` automates that: it resubmits the same last user message via
 * the existing `{ kind: 'submit' }` REPL affordance instead of asking the
 * operator to reconstruct what they typed.
 *
 * Sourcing the message: deliberately reads `session.current.getHistory()`
 * rather than `ctx.stats.turns`. `stats.turns` is populated by the turn-completion
 * recorder, which only fires once a turn finishes successfully — a turn that
 * died mid-stream from a usage-limit error never reaches it, so the very
 * message we need to resubmit would be invisible there. `getHistory()` is the
 * session's raw conversation log, which gets the user message appended at
 * send time (before the provider is even called) — see
 * `sendMessageStreamInternal` in `agent-session.ts` — so it is present
 * regardless of how the turn ended.
 *
 * Usage:
 *   /retry   — resubmit the last user message
 */

import type { SlashCommand } from '../types.js';

export const retryCmd: SlashCommand = {
  name: '/retry',
  summary: 'Resubmit the last user message (e.g. after a turn died from a usage-limit error)',
  hint: 'When a turn died mid-stream (usage-limit 429, dropped subagent fork) and the conversation is stuck on your last message — resubmits it instead of retyping.',

  async handler(ctx) {
    const history = ctx.session.current.getHistory();

    let lastUserMessage: string | undefined;
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry?.role === 'user') {
        lastUserMessage = entry.content;
        break;
      }
    }

    if (lastUserMessage === undefined || lastUserMessage.trim() === '') {
      ctx.out.info('No previous user message to retry yet — send one first.');
      return 'continue';
    }

    return { kind: 'submit', message: lastUserMessage };
  },
};
