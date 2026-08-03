/**
 * Queued-user-message envelope for Ctrl+B promotion.
 *
 * When the REPL user has typed-ahead messages queued and presses Ctrl+B to
 * background a running foreground subagent, the queued text rides the synthetic
 * promotion `ToolResult` into the parent's STILL-RUNNING turn instead of waiting
 * for the next-turn drain. This module owns the envelope, the escaping, and the
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

/** Envelope tag. Mirrors `<background-subagent-result>` / `<bash-passthrough>`. */
const TAG = 'queued-user-message';

/**
 * Cap the injected note so a pathological paste cannot dominate the parent's
 * context window. Generous relative to real typed-ahead input; the drain path
 * is lossless below it.
 */
const MAX_NOTE_BYTES = 16_384;

/**
 * Escape `&`/`<`/`>` so user text cannot forge a closing tag and inject
 * synthetic structure into the parent's context. Same defense as
 * bg-result-notifier's and shell-passthrough's local copies (kept local here
 * for the same reason they are: a 3-line leaf with no shared owner).
 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Invariant: escape BEFORE truncating. Escaping expands `<` to `&lt;` (4×), so
 * truncating pre-escape text would let 16KB of `<` balloon to ~64KB post-escape
 * and bypass the cap. Truncation may cut an entity mid-sequence (`&am`);
 * harmless in model context.
 */
function truncateBytes(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_NOTE_BYTES) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_NOTE_BYTES);
  return `${buf.toString('utf8')}\n… [truncated at ${MAX_NOTE_BYTES} bytes]`;
}

/**
 * Build the model-facing envelope for a flushed queued note.
 *
 * Returned as a plain string for `appendInjectContext`, which concatenates it
 * onto `ToolResult.content`. Deliberately NOT a separate content block: keeping
 * the text inside the tool_result's own content means we never sit between a
 * `tool_use` and its `tool_result`, so the Anthropic API's
 * "tool_result blocks first, text after" ordering rule cannot be violated, and
 * no provider-specific assembly code is needed.
 */
export function formatQueuedNote(text: string): string {
  return `<${TAG}>\n${truncateBytes(escapeXml(text))}\n</${TAG}>`;
}

/**
 * Claim the note for delivery. Returns the formatted envelope on the FIRST call
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
