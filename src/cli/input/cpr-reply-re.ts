/**
 * Shared leaf module: CPR reply regex.
 *
 * Extracted to a single source of truth so both
 * `terminal-compositor.lifecycle.cpr.ts` and `emit-keypress.ts` import from
 * here rather than maintaining independent copies.  Both files previously
 * defined their own version of this pattern; centralising avoids silent
 * divergence (#3206 review item 3).
 *
 * Pattern: matches a complete CPR (Cursor Position Report) response:
 *   ESC [ <row> ; <col> R
 * where <row> and <col> are decimal integers (1-based).
 */

/** Regex that matches a complete CPR response: ESC [ row ; col R */
export const CPR_REPLY_RE = /^\x1b\[(\d+);(\d+)R$/;
