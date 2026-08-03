/**
 * Ctrl+B queued-message flush: peek → pass → confirm → drain.
 *
 * Backgrounding a running foreground subagent unblocks the parent turn with a
 * synthetic `tool_result`. That result is the one carrier that reaches the
 * parent's STILL-RUNNING turn, so it is also how a typed-ahead message can skip
 * the next-turn queue drain and land in the turn the user is watching.
 *
 * Everything here exists to make that delivery non-lossy. The obvious
 * implementation — drain the queue, then promote — silently eats the user's
 * message whenever promotion fails (no background registry wired, or the
 * background-job cap was hit and the subagent stayed foreground). So the queue is
 * only ever READ before promotion; the agent layer marks the shared claim ticket
 * when it actually folds the text into a result, and the drain happens after that
 * confirmation or not at all.
 *
 * @module cli/commands/interactive/queued-flush
 */

/** Structural view of the compositor's out-of-band queue door. */
export interface QueuedFlushCompositor {
  peekQueuedText(): QueuedFlushSnapshot | undefined;
  dropQueued(snapshot: QueuedFlushSnapshot): number;
}

export interface QueuedFlushSnapshot {
  readonly text: string;
  readonly preview: string;
  readonly payloads: readonly unknown[];
}

/**
 * Structural view of the `SubagentControl` seam. Declared structurally so this
 * module — and the keyboard layer that calls it — never imports a subagent
 * module (see `subagent-control-boundary.test.ts`).
 */
export interface QueuedFlushControl {
  hasPromotableForeground(): boolean;
  promoteActiveForeground(queuedNote?: { readonly text: string; claimed: boolean }): Promise<
    readonly { jobId: string; label: string }[]
  >;
}

export interface QueuedFlushResult {
  /** Jobs adopted by the background registry (empty when nothing was promoted). */
  jobs: readonly { jobId: string; label: string }[];
  /** The queued text delivered into the running turn, or undefined if none was. */
  flushedText?: string;
  /** Compact display-safe representation of the flushed text. */
  flushedPreview?: string;
}

/** Max characters of flushed text echoed back to the user in the UI note. */
const PREVIEW_CHARS = 60;

/**
 * Collapse flushed text to a single short line for the confirmation note. The
 * live overlay is one line per note, so embedded newlines would corrupt the
 * frame's line accounting.
 */
export function previewOneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`;
}

/**
 * Promote every in-flight foreground subagent, flushing any queued typed-ahead
 * text into the same turn.
 *
 * Returns the adopted jobs plus the text that was actually delivered. A caller
 * that only wants the old behavior can ignore `flushedText`; a queue that could
 * not be flushed is left exactly as it was, to drain normally on the next turn.
 */
export async function promoteWithQueuedFlush(
  control: QueuedFlushControl,
  compositor: QueuedFlushCompositor | null,
  persist?: (text: string) => Promise<void> | void,
): Promise<QueuedFlushResult> {
  // Peek only — see the module note on why the drain cannot happen up front.
  const snapshot = compositor?.peekQueuedText();
  const claim = snapshot !== undefined ? { text: snapshot.text, claimed: false } : undefined;

  const jobs = await control.promoteActiveForeground(claim);

  // Ordering: the drop must follow the claim check, and the claim is only set
  // once a promotion has handed its subagent to the registry. Dropping any
  // earlier would lose the message on the cap-hit path; dropping later than the
  // next `→ idle` transition would let the existing one-per-turn drain deliver
  // the same text a second time as its own turn.
  if (claim?.claimed === true && compositor !== null && snapshot !== undefined) {
    await Promise.resolve(persist?.(claim.text)).catch(() => { /* best-effort persistence */ });
    compositor.dropQueued(snapshot);
    return { jobs, flushedText: claim.text, flushedPreview: snapshot.preview };
  }
  return { jobs };
}
