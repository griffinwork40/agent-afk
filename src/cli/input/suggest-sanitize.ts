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
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Unicode line terminators and bidi overrides/isolates. These sit outside
    // the C0/C1 ranges above, yet many terminals render U+2028/U+2029 as a line
    // break (breaking the single-line invariant the C0 strip protects), and the
    // bidi controls reorder the visible run so the ghost text a user SEES can
    // differ from the bytes Tab accepts into the buffer (Trojan Source, CVE-
    // 2021-42574). Directional marks (U+200E/U+200F/U+061C) are deliberately
    // NOT stripped: they carry no override scope and can be legitimate in RTL
    // text.
    .replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
}
