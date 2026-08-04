/**
 * Queued-user-message field for Ctrl+B promotion.
 *
 * When the REPL user has typed-ahead messages queued and presses Ctrl+B to
 * background a running foreground subagent, the queued text rides the synthetic
 * promotion `ToolResult` into the parent's STILL-RUNNING turn instead of waiting
 * for the next-turn drain. This module owns the field value, truncation, and the
 * one-shot claim ticket that makes delivery exactly-once.
 *
 * @module agent/tools/subagent/queued-note
 */

/**
 * One-shot claim ticket for a queued user note.
 *
 * Contract: the CLI layer constructs this (structurally — it must NOT import
 * from this module; see the `src/cli/**` → subagent boundary test) and hands it
 * to `SubagentControl.promoteActiveForeground`. The executor passes the SAME
 * object to every in-flight promotion trigger, so `claimed` is what makes
 * delivery exactly-once when several subagents are promoted by one keypress.
 *
 * The caller reads `claimed` AFTER promotion settles to decide whether to drain
 * its queue: `false` means no promotion consumed the note (no registry wired, or
 * the background-job cap was hit and the run stayed foreground), so the message
 * must remain queued rather than being silently dropped.
 */
export interface QueuedNoteClaim {
  /** Coalesced FIFO text of every queued payload, newline-joined. */
  readonly text: string;
  /** Set true by the first promotion that folds `text` into its ToolResult. */
  claimed: boolean;
}

/**
 * Cap the injected note so a pathological paste cannot dominate the parent's
 * context window. Generous relative to real typed-ahead input; the drain path
 * is lossless below it.
 */
const MAX_NOTE_BYTES = 16_384;

const TRUNCATION_MARKER = `\n… [truncated at ${MAX_NOTE_BYTES} bytes]`;

/** Serialized wire size: the note ships as a JSON string value, not raw. */
function serializedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8');
}

/**
 * Truncate the field value to fit the cap once serialized.
 *
 * Invariant: the cap is measured against `JSON.stringify(text)`, not the raw
 * string, because the note is delivered as a JSON string value — escaping
 * (`"`, `\`, control chars) expands it on the wire, so a raw-string
 * measurement lets an escape-dense paste exceed the cap after serialization.
 * Slicing walks code points (`Array.from`) rather than bytes: a byte-wise
 * `subarray` splits multi-byte UTF-8 sequences and corrupts the trailing
 * character to U+FFFD. JSON serialization establishes the structural
 * boundary, so no XML escaping or forgeable sentinel is involved.
 */
function truncateBytes(text: string): string {
  if (serializedBytes(text) <= MAX_NOTE_BYTES) return text;
  const chars = Array.from(text);
  const fits = (n: number): boolean =>
    serializedBytes(chars.slice(0, n).join('') + TRUNCATION_MARKER) <= MAX_NOTE_BYTES;
  // Largest code-point prefix that still fits once the marker is appended.
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('') + TRUNCATION_MARKER;
}

/** Build the bounded text for the harness-authenticated user-message carrier. */
export function formatQueuedNote(text: string): string {
  return truncateBytes(text);
}

/**
 * Claim the note for delivery. Returns the field value on the FIRST call
 * for a given ticket and `undefined` on every later call (and for an absent or
 * blank ticket), so N simultaneous promotions deliver the user's message once.
 *
 * Single-threaded by construction: JS runs this check-then-set without
 * interleaving, so no lock is required.
 */
export function claimQueuedNote(claim: QueuedNoteClaim | undefined): string | undefined {
  if (claim === undefined || claim.claimed) return undefined;
  if (claim.text.trim().length === 0) return undefined;
  claim.claimed = true;
  return formatQueuedNote(claim.text);
}
