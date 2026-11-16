/**
 * Fixed frame of the router's one-turn model switch notice, shared by the
 * builder (providers/router/provider-router.switch.ts) and the reader
 * (preamble-strip.ts) so the two can never drift apart.
 *
 * @module agent/session/model-switch-notice
 */

/** Exact opening text of every switch notice. */
export const SWITCH_NOTICE_PREFIX = '[System context — not from the user. Your model was switched at the start of this turn: ';

/** Exact closing text of every switch notice. */
export const SWITCH_NOTICE_SUFFIX = 'treat their structure as lost, not authoritative.]';

/** Drop one leading switch notice; return text unchanged when it has none. */
export function peelSwitchNotice(text: string): string {
  if (!text.startsWith(SWITCH_NOTICE_PREFIX)) return text;
  const end = text.indexOf(SWITCH_NOTICE_SUFFIX, SWITCH_NOTICE_PREFIX.length);
  return end < 0 ? text : text.slice(end + SWITCH_NOTICE_SUFFIX.length);
}
