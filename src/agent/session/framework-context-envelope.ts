/**
 * Harness-owned envelope around framework context drained into a user message.
 *
 * Contract: hook output (SessionStart `injectContext`, plugin
 * `additionalContext`, MCP notices, SubagentStop and Telegram/web Stop
 * context) is queued by the session and drained in front of the next
 * outbound user message by `TurnStreamRunner.withPendingContext`, the single
 * drain site for every surface and provider. It wraps the drained text as
 *
 *   <framework-context>
 *   ...drained text...
 *   </framework-context>
 *
 *   <user content>
 *
 * so every consumer can recover what the user typed by cutting through the
 * FIRST closing tag, instead of inferring the boundary from plugin wording.
 * Hook output is untrusted text, so any literal closing tag inside it is
 * neutralized before wrapping; the first closing tag is always the boundary.
 *
 * @module agent/session/framework-context-envelope
 */

export const FRAMEWORK_CONTEXT_OPEN = '<framework-context>';
export const FRAMEWORK_CONTEXT_CLOSE = '</framework-context>';

/** Any closing-tag spelling a lenient consumer might honour. */
const CLOSE_TAG_VARIANTS_RE = /<\/\s*framework-context\s*>/gi;

/** Replace every closing tag inside untrusted text with an inert spelling. */
export function neutralizeFrameworkContext(text: string): string {
  return text.replace(CLOSE_TAG_VARIANTS_RE, '&lt;/framework-context&gt;');
}

/**
 * Wrap drained framework context in the envelope. Returns '' for empty or
 * whitespace-only input so callers never emit an empty envelope.
 */
export function wrapFrameworkContext(text: string): string {
  const body = text.trim();
  if (body.length === 0) return '';
  return `${FRAMEWORK_CONTEXT_OPEN}\n${neutralizeFrameworkContext(body)}\n${FRAMEWORK_CONTEXT_CLOSE}`;
}

/**
 * When `text` opens with the envelope, return everything after it, trimmed
 * (possibly ''). Consecutive leading envelopes are all peeled, so a second
 * producer adopting the envelope cannot leak its context as user text. An
 * unterminated envelope (e.g. a truncated preview of a huge
 * message) yields '': nothing after the opening tag can be trusted as
 * user-authored. Returns undefined only when `text` does not open with an
 * envelope.
 */
export function textAfterFrameworkContext(text: string): string | undefined {
  let rest = text.trimStart();
  if (!rest.startsWith(FRAMEWORK_CONTEXT_OPEN)) return undefined;
  while (rest.startsWith(FRAMEWORK_CONTEXT_OPEN)) {
    const closeIdx = rest.indexOf(FRAMEWORK_CONTEXT_CLOSE);
    if (closeIdx < 0) return '';
    rest = rest.slice(closeIdx + FRAMEWORK_CONTEXT_CLOSE.length).trimStart();
  }
  return rest.trim();
}
