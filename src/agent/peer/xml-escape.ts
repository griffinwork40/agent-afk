/**
 * Shared XML escaping helper for peer-messaging XML blocks.
 *
 * Provides the canonical five-replacement escaper used by
 * {@link ../peer/envelope} (attribute values and body content).
 * Callers that only need to escape body content (not attribute values)
 * may use the same function — the additional `"` and `'` replacements
 * are harmless in body context.
 *
 * @module agent/peer/xml-escape
 */

/**
 * Minimal XML escaping — five replacements: `&`, `<`, `>`, `"`, `'`.
 *
 * Guards against adversarial content that injects arbitrary XML structure
 * into model context via closing tags or attribute breakout sequences (e.g.
 * `</peer-session-message>` in a body, or `"` in an attribute value).
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
