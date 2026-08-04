/**
 * Control-character scrubbing for untrusted suggestion text.
 *
 * Split out of `./suggest` so every producer of ghost text — the Tier-2
 * completion tier, the empty-prompt proposal, the compositor's render and
 * accept paths — can share one sanitizer without importing the engine (and
 * without the engine module growing a second concern).
 *
 * `suggest.ts` re-exports {@link stripGhostControlChars} so the historical
 * import path (`./input/suggest.js`) keeps working unchanged.
 *
 * @module cli/input/suggest-sanitize
 */

/**
 * Strip terminal control sequences and control characters from untrusted
 * model output before it is rendered as ghost text or seeded into the input
 * buffer.
 *
 * Contract: LLM completions are untrusted input. A malicious or buggy
 * completion endpoint (a local OpenAI shim, a compromised proxy) could emit
 * ANSI/CSI cursor moves, `ESC[2J` screen clears, or OSC sequences (e.g. OSC 52
 * clipboard writes). Even a well-behaved model can return an embedded newline,
 * which would break the compositor's single-line input render and corrupt its
 * DECSTBM scroll-region accounting. We remove all of it at this boundary so
 * both the render path AND the Tab/→ accept-into-buffer path are covered.
 *
 * Order matters: full escape sequences are removed before lone control bytes —
 * stripping the leading ESC first would leave the payload (e.g. `[2J`) behind
 * as visible text.
 */
export function stripGhostControlChars(text: string): string {
  return text
    // CSI: ESC [ … final-byte  (cursor moves, SGR, erase line/screen, …)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] … (BEL- or ST-terminated)  (title set, clipboard, hyperlinks)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    // Other two-byte Fe escapes (ESC followed by one byte in @–_)
    .replace(/\u001b[@-_]/g, '')
    // Remaining C0 controls (incl. \n \r \t \b), DEL, and C1 controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}
