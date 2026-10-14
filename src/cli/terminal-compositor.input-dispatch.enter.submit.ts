/**
 * Submit-path helpers extracted from handleEnter in
 * terminal-compositor.input-dispatch.enter.ts.
 *
 * Exports: handleEnterIdleSubmit, handleEnterStreamingQueue.
 * Both are free functions taking an explicit KeyDispatchHost; no module-scope
 * state is introduced here.
 */

import { InputCore } from './input-core.js';
import * as Paste from './terminal-compositor.paste.js';
import { env } from '../config/env.js';
import { mergeSubmissionPayloads } from './terminal-compositor.input-dispatch.enter.js';
import type { SubmissionPayload } from './terminal-compositor.types.js';
import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';

// ---------------------------------------------------------------------------
// handleEnterIdleSubmit
// ---------------------------------------------------------------------------

/**
 * Idle-mode Enter: resolve onSubmit immediately and clear compose state.
 *
 * Contract: caller must guard `self.inputMode === 'idle' && self.onSubmit`
 * before invoking. Clears state BEFORE invoking the handler so a reentrant
 * call (handler synchronously calls setInputMode / applyEdit / etc.) does not
 * double-fire or race a stale buffer. Returns `true` always (caller returns).
 *
 * History: extracted from handleEnter during #3478 refactor; logic is
 * identical to the inline block at handleEnter:103–141 in the pre-split file.
 */
export function handleEnterIdleSubmit(self: KeyDispatchHost): true {
  // See the setInputMode flush path for the displayText contract — keep the
  // placeholder representation alive for the scrollback echo while sending
  // the expanded form to the model. Equal on the no-truncation fast path.
  const displayText = self.input.buffer;
  const expandedText = Paste.expandPastePlaceholders(self, displayText);
  const attachments = [...self.attachments];
  const handler = self.onSubmit!;
  // Clear local state BEFORE invoking the handler so a reentrant
  // call (handler synchronously calls setInputMode('streaming') /
  // applyEdit / etc.) does not double-fire or race a stale buffer.
  // Mirrors the same invariant in setInputMode's streaming→idle flush.
  // `queued` mirrors the committed-message FIFO (untouched on this
  // immediate-submit path), so keep it in sync instead of clearing.
  self.queued = self.pendingSubmissions.length > 0;
  self.input = InputCore.seed('');
  self.attachments = [];
  self.pasteRegistry.clear();
  // Reset autocomplete before repainting so dropdown chrome from
  // this input turn does not bleed into the echo-commit frame or
  // the subsequent streaming-turn frames. Stage 3e made the
  // compositor persistent across turns, so resetState() / disarm()
  // no longer runs here — this is the turn-boundary reset.
  self.autocompleteState?.reset();
  self.repaint();
  handler(
    expandedText === displayText
      ? { text: expandedText, attachments }
      : { text: expandedText, displayText, attachments },
  );
  return true;
}

// ---------------------------------------------------------------------------
// handleEnterStreamingQueue
// ---------------------------------------------------------------------------

/**
 * Streaming-mode Enter: commit the current buffer to the pending-submission
 * FIFO (with post-ESC coalescing when armed) and clear the compose window.
 *
 * // Invariant: after an ESC soft-stop, Enter must NOT accumulate a type-ahead
 * // backlog. The teardown gap — the async window between ESC and the turn loop
 * // actually breaking (for a subagent turn, cancelActiveForeground() in
 * // subagent-executor.ts resolves the parent `await` only after the child
 * // settles, seconds for a deep/wide wave) — keeps the compositor in 'streaming'
 * // while the user, seeing no new turn, types a redirect and pokes ".". If each
 * // Enter pushed its own FIFO entry, the queue would drain ONE payload per turn
 * // (the `→ idle` flush), stranding the user one turn behind: the "it doesn't
 * // send, then I keep sending characters to catch up" report — the lone-"."
 * // messages. So across the whole post-ESC epoch, messages COALESCE into a
 * // single payload that runs as exactly one next turn — no backlog.
 * //
 * // Epoch, not just the softStopped window. `postEscCoalesce` is armed at ESC
 * // and held until the coalesced payload DRAINS (setInputMode's `→ idle` shift),
 * // NOT cleared at the first teardown `→ idle` the way `softStopped` is. This
 * // covers the residual #81/#403/#467 missed: a poke that lands AFTER teardown
 * // (softStopped already false) but before the redirect visibly starts.
 * //
 * // Merge target by REFERENCE (`postEscPayload`), not a FIFO index. Any pre-ESC
 * // payloads stay their own entries (handleEscape leaves postEscPayload null, so
 * // they are never the merge target) and drain as their own sequential turns —
 * // the handleEscape contract ("already-queued messages: left untouched") holds.
 * // A reference survives those pre-ESC entries draining ahead of it, whereas the
 * // old index (`softStopQueueBase`) went stale after any `shift()`.
 *
 * History: extracted from handleEnter during #3478 refactor; logic is
 * identical to the inline block at handleEnter:142–320 in the pre-split file.
 */
export function handleEnterStreamingQueue(self: KeyDispatchHost): true {
  const displayText = self.input.buffer;
  const expandedText = Paste.expandPastePlaceholders(self, displayText);
  const attachments = [...self.attachments];
  const payload: SubmissionPayload =
    expandedText === displayText
      ? { text: expandedText, attachments }
      : { text: expandedText, displayText, attachments };

  if (self.postEscCoalesce) {
    // Invariant: while the coalesce epoch is armed, `postEscPayload` is either
    // null (no target committed yet this epoch) OR a reference that is PRESENT
    // in `pendingSubmissions`. Every site that removes the tracked payload
    // clears this reference — with DELIBERATELY asymmetric epoch semantics that
    // must NOT be collapsed into one shared helper:
    //   • ↑-recall pop (handleVerticalNav) clears `postEscPayload` ONLY and
    //     leaves the epoch armed, so the edited draft re-establishes a fresh
    //     target on re-Enter.
    //   • drain shift (input-mode `→ idle`) clears BOTH — the target is now a
    //     running turn, so the epoch is over.
    //   • resetState clears everything on disarm/rearm.
    // Therefore a NON-null `postEscPayload` that is ABSENT from the queue is an
    // invariant violation (a future removal site that forgot to clear it),
    // never a normal state. We must NOT feed an absent reference back into
    // mergeSubmissionPayloads — doing so resurrects stale, already-recalled text
    // (the exact PR #644 ↑-recall bug). So: merge only a target that is actually
    // present; otherwise start a FRESH target. Worst case under a future
    // violation is a stranded extra turn — never resurrected text.
    const target = self.postEscPayload;
    const idx = target !== null ? self.pendingSubmissions.indexOf(target) : -1;
    if (target !== null && idx >= 0) {
      // Live target present — merge in place (same FIFO slot) so the whole
      // post-stop burst becomes ONE next turn. Merge joins texts with newlines +
      // concatenates attachments (never last-wins, which silently dropped
      // earlier post-ESC messages — the #467 regression).
      const merged = mergeSubmissionPayloads([target, payload]);
      self.pendingSubmissions[idx] = merged;
      self.postEscPayload = merged;
    } else {
      // Either the first message this epoch (target === null — the normal case)
      // or, under a FUTURE invariant violation, a dangling reference. Fail loud
      // in dev/test so CI catches the offending removal site; production
      // degrades safely by starting a fresh target rather than re-merging the
      // absent reference.
      if (target !== null && env.NODE_ENV !== 'production') {
        throw new Error(
          'terminal-compositor: post-ESC coalesce reference is dangling ' +
            '(postEscPayload non-null but absent from pendingSubmissions) — a ' +
            'pendingSubmissions removal site failed to clear the epoch reference.',
        );
      }
      self.postEscPayload = payload;
      self.pendingSubmissions.push(payload);
    }
  } else {
    // Normal mid-turn type-ahead (no ESC, postEscCoalesce === false): accumulate
    // one payload per message — sequential-turn delivery is the intended
    // contract there (the "NO ESC" regression tests).
    self.pendingSubmissions.push(payload);
  }

  self.queued = true; // maintained mirror: pendingSubmissions is now non-empty
  // Clear the compose window for the next message. Mirrors the idle-mode
  // submit reset above so dropdown chrome / paste side-table / attachments
  // from this message don't bleed into the next.
  self.input = InputCore.seed('');
  self.attachments = [];
  self.pasteRegistry.clear();
  self.history?.resetRecall();
  self.autocompleteState?.reset();
  self.repaint();
  // Usage-limit pause escape: while the turn is parked waiting for auto-resume
  // (the loop is suspended in `await runTurn`), a queued message would otherwise
  // sit stranded behind the wait. Fire the pause-interrupt so the wait ends
  // (handler calls session.interrupt) and the committed payload drains as the
  // NEXT turn via the idle-transition flush — the same path ESC uses.
  // Ordering: payload is committed and compose window cleared ABOVE, then we
  // interrupt (teardown-before-setup). Idempotent if the user presses Enter
  // twice (interrupt is idempotent); the second payload joins the FIFO and
  // drains as a subsequent turn.
  if (self.paused && self.onPauseInterrupt) self.onPauseInterrupt();
  return true;
}
