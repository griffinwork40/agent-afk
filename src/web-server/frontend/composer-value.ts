/**
 * Programmatic writes to the composer textarea.
 *
 * Invariant: the DOM fires `input` only for user-driven edits. Assigning
 * `.value` from code changes the text silently, and everything downstream of
 * the composer — the slash-highlight mirror, which is the ONLY visible copy of
 * the text because the textarea itself is painted `color: transparent`, and the
 * autocomplete's own re-trigger — listens on `input` alone. So any code path
 * that sets `.value` must announce it, or the operator keeps reading stale text
 * until their next keystroke happens to repaint it.
 *
 * Kept in its own module because two unrelated owners need it (the autocomplete
 * on accept, the queue panel on send) and neither should import the other.
 */

/**
 * Announce a programmatic `.value` write so `input` listeners re-run.
 *
 * Contract: dispatches a non-bubbling `input` Event on `input`. Safe to call
 * after any assignment — listeners re-read `.value` rather than trusting the
 * event payload, so an extra notification is idempotent.
 */
export function notifyValueChanged(input: HTMLTextAreaElement): void {
  input.dispatchEvent(new Event('input'));
}
