/**
 * Switch-notice helpers extracted from provider-router.ts to keep that file
 * within the 350-code-line ceiling.
 *
 * These three functions handle the "model was switched" cross-turn context
 * that a freshly-rebuilt inner provider receives when the operator changes
 * models mid-session.
 *
 * @module agent/providers/router/provider-router.switch
 */

import type { ProviderUserTurn } from '../../provider.js';

/**
 * Flatten a user-turn content value to plain text for the shadow history.
 * Non-text blocks (images, etc.) are dropped — shadow history is text-only.
 */
export function stringifyUserContent(content: ProviderUserTurn['content']): string {
  if (typeof content === 'string') return content;
  // ContentBlockParam[] — extract text blocks for the text-only shadow history.
  // Non-text blocks (images) are dropped from the carry; this is intentional.
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter((t) => t.length > 0)
    .join('\n');
}

/**
 * Build the one-turn "your model was switched" system context prepended to the
 * first turn a freshly-swapped inner serves.
 *
 * Motivation: an inner rebuild is otherwise INVISIBLE to the model — the new
 * inner's `session.init` is swallowed (so no re-init is surfaced) and the
 * carried conversation is anonymous prose (the module-level cross-family
 * invariant). Without this notice the switched-to model has no in-context signal
 * that (a) it is a different model than the one that produced earlier turns, or
 * (b) prior structured tool/thinking content was flattened to text — which
 * invites it to over-trust or misattribute the history (e.g. narrate its own
 * identity from a stale premise). The notice is descriptive context, NOT an
 * instruction, and rides only the swap turn — it expires after one turn like any
 * framework nudge.
 */
export function buildSwitchNotice(
  previousModel: string,
  currentModel: string,
  previousFamily: string | undefined,
  currentFamily: string,
): string {
  const familyClause =
    previousFamily && previousFamily !== currentFamily
      ? ` (provider ${previousFamily} → ${currentFamily})`
      : '';
  return (
    `[System context — not from the user. Your model was switched at the start of this turn: ` +
    `${previousModel} → ${currentModel}${familyClause}. Earlier turns in this conversation were produced ` +
    `by ${previousModel}; the history carried across the switch is plain text only, so any prior tool ` +
    `calls and extended reasoning are now prose — treat their structure as lost, not authoritative.]`
  );
}

/** Prepend a synthetic notice as a leading text block (or line) to outbound turn content. */
export function prependNotice(
  content: ProviderUserTurn['content'],
  notice: string,
): ProviderUserTurn['content'] {
  if (typeof content === 'string') {
    return content.length > 0 ? `${notice}\n\n${content}` : notice;
  }
  return [{ type: 'text' as const, text: notice }, ...content];
}
