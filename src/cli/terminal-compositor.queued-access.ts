/**
 * Out-of-band read/drain access to the typed-ahead submission queue.
 *
 * The normal queue lifecycle is enqueue-on-Enter (`.input-dispatch`) →
 * drain-one-on-idle (`.input-mode`). Ctrl+B needs a THIRD door: peek the queued
 * text while the turn is still streaming, then remove that snapshot only once the agent
 * layer confirms the text was actually delivered into the running turn. Both
 * halves live here so the `postEscPayload` bookkeeping contract has exactly one
 * out-of-band owner rather than being re-implemented at the keypress site.
 *
 * @module cli/terminal-compositor.queued-access
 */

import type { SubmissionPayload } from './terminal-compositor.types.js';

/**
 * Minimal host surface. Structural, so the compositor class satisfies it
 * without this module importing the class (which would be circular).
 */
export interface QueuedAccessHost {
  pendingSubmissions: SubmissionPayload[];
  queued: boolean;
  postEscCoalesce: boolean;
  postEscPayload: SubmissionPayload | null;
  repaint(): void;
}

export interface QueuedSnapshot {
  readonly text: string;
  readonly preview: string;
  /** Opaque payload identities used to consume exactly this snapshot. */
  readonly payloads: readonly SubmissionPayload[];
}

/**
 * Snapshot of every currently queued payload, FIFO order, newline-joined —
 * `undefined` when nothing is queued or nothing survives trimming.
 *
 * Read-only by contract: Ctrl+B must not consume the queue before the agent
 * layer confirms delivery, because promotion can legitimately fail (no
 * background registry wired, or the background-job cap was hit) and the message
 * must then stay queued.
 *
 * Attachments are a hard bail-out, not a silent drop: a flushed note rides a
 * `tool_result` content string, which cannot carry image blocks. When any queued
 * payload has attachments we return `undefined` so the whole queue drains
 * normally as its own turn with its images intact.
 */
export function peekQueuedText(self: QueuedAccessHost): QueuedSnapshot | undefined {
  if (self.pendingSubmissions.length === 0) return undefined;
  if (self.pendingSubmissions.some((p) => p.attachments.length > 0)) return undefined;
  const payloads = [...self.pendingSubmissions];
  const text = payloads.map((p) => p.text).join('\n');
  if (text.trim().length === 0) return undefined;
  return {
    text,
    preview: payloads.map((p) => p.displayText ?? p.text).join('\n'),
    payloads,
  };
}

/**
 * Remove only the snapshotted payloads after their text has been delivered out-of-band.
 * Returns how many were dropped.
 *
 * Invariant (post-ESC epoch bookkeeping — see the removal-site contract in
 * `.input-dispatch`'s coalesce block): a non-null `postEscPayload` must always
 * be PRESENT in `pendingSubmissions`, and every site that removes the tracked
 * payload has to clear the reference or the next post-ESC Enter throws on a
 * dangling target. This site is semantically the drain case, not the ↑-recall
 * case: the text is now bound for a RUNNING turn, so the coalesce epoch is over
 * and BOTH the flag and the reference are cleared — matching what the
 * `→ idle` drain does, not the recall pop (which deliberately leaves the epoch
 * armed).
 */
export function dropQueued(self: QueuedAccessHost, snapshot: QueuedSnapshot): number {
  const included = new Set(snapshot.payloads);
  const dropped = self.pendingSubmissions.reduce((n, payload) => n + Number(included.has(payload)), 0);
  if (dropped === 0) return 0;
  self.pendingSubmissions = self.pendingSubmissions.filter((payload) => !included.has(payload));
  self.queued = self.pendingSubmissions.length > 0;
  if (self.postEscPayload !== null && included.has(self.postEscPayload)) {
    self.postEscCoalesce = false;
    self.postEscPayload = null;
  }
  self.repaint();
  return dropped;
}
