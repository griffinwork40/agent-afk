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

/**
 * /**
 * Truncate the field value by bytes. JSON serialization later establishes the
 * structural boundary, so no XML escaping or forgeable sentinel is involved.
 */
function truncateBytes(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_NOTE_BYTES) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_NOTE_BYTES);
  return `${buf.toString('utf8')}\n… [truncated at ${MAX_NOTE_BYTES} bytes]`;
}

/**
 * Build the value for the harness-owned `queuedUserMessage` JSON field.
 */
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
