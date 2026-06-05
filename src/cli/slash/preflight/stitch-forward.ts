/**
 * Stitch a preflight manifest into the user-text payload for a plugin-skill
 * forward dispatch.
 *
 * The forward path concatenates everything into a single user message (the
 * REPL doesn't get to build separate ContentBlockParams the way the native
 * handler does). The wrapper is the structural signal that the prepended
 * block is runtime-injected context — not the user's words — preventing
 * the model from echoing or paraphrasing the manifest back.
 *
 * Pure function with no side effects. Trivial enough to inline, but
 * extracted so it can be unit-tested in isolation from the REPL loop.
 *
 * Contract:
 * - Manifest precedes the slash line at the tail so the plugin-skill body
 *   expansion still fires on `/<skill>`.
 * - When `manifestBlock` is empty/whitespace, returns `slashLine` unchanged.
 * - Wraps the manifest in `<system-reminder>` only when a non-empty
 *   manifest is present — never inserts an empty reminder.
 */
/**
 * Stitch a preflight manifest into a slash line for the plugin-forward path.
 *
 * @param manifestBlock - Preflight manifest content to prepend, or undefined/empty
 *   to pass through unchanged. Must be trusted-origin content (from a registered
 *   SkillPreflight) — never pass user-supplied text here.
 * @param slashLine     - F12: The raw slash command line as entered by the user
 *   (e.g. `/mint some idea`). Trusted-input-only origin: this value is the
 *   verbatim REPL input and must have already passed through the dispatcher's
 *   parse step. Do not pass pre-constructed strings from untrusted sources.
 */
export function stitchForwardManifest(
  manifestBlock: string | undefined,
  slashLine: string,
): string {
  if (!manifestBlock || manifestBlock.trim().length === 0) {
    return slashLine;
  }
  // Strip any injected closing tag (case-insensitive) before wrapping —
  // defense-in-depth against prompt-injection via manifest content.
  const safe = manifestBlock.replace(/<\/system-reminder>/gi, '');
  return `<system-reminder>\n${safe}\n</system-reminder>\n\n${slashLine}`;
}
