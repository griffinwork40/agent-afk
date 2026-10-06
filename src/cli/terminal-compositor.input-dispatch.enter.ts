/**
 * Enter-key dispatch and its immediate helpers — extracted from
 * terminal-compositor.input-dispatch.ts.
 *
 * Exports: handleEnter (main Enter guard-chain leaf), handleBackspace,
 * commitIfChanged, applyAtomicPlaceholderDelete, mergeSubmissionPayloads.
 * All are free functions that take an explicit KeyDispatchHost parameter;
 * no module-scope state is introduced here.
 */

import { InputCore } from './input-core.js';
import * as Paste from './terminal-compositor.paste.js';
import { env } from '../config/env.js';
import { isSoftNewlineEnter, endsWithBackslashContinuation } from './input/enter-decision.js';
import type { KeyInfo, SubmissionPayload } from './terminal-compositor.types.js';
import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';

// ---------------------------------------------------------------------------
// mergeSubmissionPayloads
// ---------------------------------------------------------------------------

/**
 * Merge multiple soft-stop-window submissions into ONE payload.
 *
 * Texts join with a newline (empty texts skipped) so every post-ESC message
 * the user typed survives into the single coalesced next turn; attachments
 * concatenate in submission order. `displayText` merges the same way -- it is
 * emitted only when at least one constituent carried a distinct displayText
 * (i.e. a paste placeholder was expanded somewhere), mirroring the
 * "absent when identical" contract on SubmissionPayload.
 */
export function mergeSubmissionPayloads(payloads: readonly SubmissionPayload[]): SubmissionPayload {
  if (payloads.length === 1) return payloads[0]!;
  const text = payloads
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join('\n');
  const attachments = payloads.flatMap((p) => [...p.attachments]);
  const hasDisplay = payloads.some((p) => p.displayText !== undefined);
  if (!hasDisplay) return { text, attachments };
  const displayText = payloads
    .map((p) => p.displayText ?? p.text)
    .filter((t) => t.length > 0)
    .join('\n');
  return { text, displayText, attachments };
}

// ---------------------------------------------------------------------------
// commitIfChanged
// ---------------------------------------------------------------------------

/**
 * The buffer-edit commit contract shared by the "transform, commit only if it
 * changed" bindings (meta word-delete, Ctrl+W/U/K kills): apply a pure
 * InputCore transition only when it actually changes the buffer, resetting
 * history recall FIRST on a real edit (the convention documented in
 * handleCursorAndEdit). Returns `true` so a handled binding can tail-call it
 * as `return commitIfChanged(self, InputCore.x(self.input))`.
 */
export function commitIfChanged(self: KeyDispatchHost, next: ReturnType<typeof InputCore.seed>): true {
  if (next !== self.input) {
    self.history?.resetRecall();
    self.applyEdit(next);
  }
  return true;
}

// ---------------------------------------------------------------------------
// applyAtomicPlaceholderDelete
// ---------------------------------------------------------------------------

/**
 * Atomic paste-placeholder delete shared by Backspace (backward) and Delete
 * (forward): when the cursor abuts a `[Pasted text #N +M lines]` token, the
 * whole token (and its side-table entry) is removed in one keystroke. Returns
 * `true` when a token was consumed (caller stops), `false` to fall through to
 * the normal character delete.
 */
export function applyAtomicPlaceholderDelete(
  self: KeyDispatchHost,
  direction: 'backward' | 'forward',
): boolean {
  const atomic = Paste.maybeAtomicPlaceholderDelete(self, direction);
  if (atomic) {
    self.history?.resetRecall();
    self.applyEdit(atomic);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// handleBackspace
// ---------------------------------------------------------------------------

export function handleBackspace(self: KeyDispatchHost, key: KeyInfo): boolean {
  if (key?.name !== 'backspace') return false;
  // Option+Delete on macOS -> meta+backspace: delete previous word.
  // Mirrors reader.ts:677 so word-erase is consistent across both
  // input surfaces.
  if (key?.meta) {
    return commitIfChanged(self, InputCore.deleteWordBackward(self.input));
  }
  // Atomic placeholder delete -- when the cursor sits at the
  // trailing `]` of a `[Pasted text #N +M lines]` token, single
  // Backspace removes the whole token (and drops the side-table
  // entry). Without this, deleting a freshly-pasted blob requires
  // ~30 backspaces. Run BEFORE the InputCore.backspace fallback
  // so the atomic path wins when both would fire.
  if (applyAtomicPlaceholderDelete(self, 'backward')) return true;
  const next = InputCore.backspace(self.input);
  if (next !== self.input) {
    self.history?.resetRecall();
    self.applyEdit(next);
  } else if (self.attachments.length > 0) {
    // Buffer empty + attachments present -- pop the last attachment.
    // Ported from reader.ts:668. Lets the user "undo" an
    // accidental clipboard paste without retyping.
    self.attachments.pop();
    self.repaint();
  }
  // Note: Backspace deliberately does NOT dequeue. Committed type-ahead
  // messages (pendingSubmissions) are recalled for editing via up-arrow
  // (handleVerticalNav) -- non-destructive -- never discarded here.
  return true;
}

// ---------------------------------------------------------------------------
// handleEnter
// ---------------------------------------------------------------------------

export function handleEnter(self: KeyDispatchHost, key: KeyInfo, sequence: string): boolean {
  if (key?.name !== 'return') return false;
  // ── Newline-insertion guards ─────────────────────────────────
  //
  // Invariant: these two branches must run BEFORE any submit /
  //   queue / dropdown logic. They convert Enter into a literal
  //   `\n` insertion when the keystroke originated from pasted
  //   content or an explicit user request for a soft newline. If
  //   the submit path runs first, the first line break inside a
  //   multi-line paste fires onSubmit (idle mode) or sets queued
  //   (streaming mode) with the partial buffer — the remaining
  //   pasted lines arrive AFTER and are either silently dropped
  //   (idle: stale state cleared in submit handler) or interleave
  //   with the next turn's input. Ported from reader.ts:697-732.
  //
  // 1. shift+Enter / alt+Enter — explicit user intent for a soft
  //    newline. Modifier reporting varies by terminal; the kitty
  //    keyboard protocol fallback covers terminals that don't set
  //    `key.shift` but DO send `\x1b[13;2u`.
  // 2. `self.pasting` — between bracketed-paste markers. `\r`
  //    keypresses here are clipboard content, not user submission.
  //    Requires arm() to have enabled `\x1b[?2004h` so the terminal
  //    sends the markers; arm() does this unconditionally on TTY.
  //
  // No burst-detection fallback: it relies on Date.now() millisecond
  // resolution and cannot reliably distinguish a paste batched into
  // a single libuv read tick (same Date.now()) from rapid synthetic
  // emits in tests. Bracketed-paste mode is the reliable signal —
  // and is enabled on every TTY in arm().
  if (isSoftNewlineEnter(key, sequence)) {
    // Explicit user-driven newline — route through applyEdit so the
    // autocomplete dropdown closes (a `\n` in the buffer almost
    // never matches a trigger), history recall is reset, and a
    // single repaint shows the new line.
    self.history?.resetRecall();
    self.applyEdit(InputCore.insert(self.input, '\n'));
    return true;
  }
  if (self.pasting) {
    // Mid-paste literal newline — bypass applyEdit to skip the
    // per-character autocomplete recompute (a 10KB multi-line paste
    // would otherwise call detectTrigger() once per `\r`). The
    // end-of-paste marker (`\x1b[201~`) triggers a single repaint
    // over the final buffer. Editing the live buffer does NOT touch the
    // committed-message FIFO, so keep `queued` mirroring pendingSubmissions
    // rather than clearing it unconditionally (the pre-multi-queue clear
    // assumed the buffer WAS the single queued message; commit-on-Enter
    // retired that coupling).
    self.input = InputCore.insert(self.input, '\n');
    self.queued = self.pendingSubmissions.length > 0;
    return true;
  }
  // Dropdown-open: apply the highlighted candidate before any
  // submit/queue path runs. Mirrors reader.ts:734-748 — the
  // canonical Enter-with-dropdown logic that the compositor must
  // honor now that Stage 3e (commit 4e28e5d) routes ALL TTY Enter
  // through dispatchKey().
  //
  // Semantics by trigger kind:
  //  • slash  → finalize the choice AND fall through to submit. One
  //    Enter both completes "/mi" → "/mint " and fires it.
  //  • file/flag → finalize only. The user is likely mid-sentence
  //    (e.g. typing "look at @src/foo.ts and ...") — submitting a
  //    bare path would be a mistake. Tab still accepts-only too.
  //  • slash with no matching candidate (applySelection no-op) →
  //    suppress submit so the raw "/mi" partial does not escape as
  //    a non-command message. COR-2 in reader.ts.
  const ac = self.autocompleteState;
  if (ac?.dropdownOpen) {
    const kind = ac.trigger?.kind;
    const applied = self.applyDropdownSelection();
    if (kind !== 'slash') return true;
    if (!applied) return true;
    // Slash + applied: fall through with the now-completed buffer.
  }
  // Trailing backslash escapes Enter → convert to a real newline. The
  // documented escape hatch (mirrors reader.ts via endsWithBackslashContinuation)
  // for terminals that don't report shift-state on Enter; without it the live
  // REPL submitted the raw trailing `\` instead of continuing onto a new line.
  // Routed through applyEdit (like the soft-newline branch above) so the
  // dropdown closes and history recall resets.
  if (endsWithBackslashContinuation(self.input.buffer)) {
    self.history?.resetRecall();
    self.applyEdit(
      InputCore.replaceRange(
        self.input,
        { start: self.input.buffer.length - 1, end: self.input.buffer.length },
        '\n',
      ),
    );
    return true;
  }
  // Allow Enter to submit attachment-only messages (empty text + ≥1
  // image) — matches readWithAutocomplete's behavior on Ctrl+D /
  // Enter and is the natural model for "I just want to send this
  // screenshot for the agent to look at."
  if (self.input.buffer.length === 0 && self.attachments.length === 0) return true;
  // Idle mode: Enter resolves onSubmit immediately. Used by the
  // persistent InputSurface between turns. Falls through to the
  // legacy queue behavior when no handler is installed (defensive —
  // a future caller setting mode='idle' without setOnSubmit would
  // otherwise silently swallow Enter).
  if (self.inputMode === 'idle' && self.onSubmit) {
    // See the setInputMode flush path above for the displayText
    // contract — keep the placeholder representation alive for
    // the scrollback echo while sending the expanded form to the
    // model. Equal on the no-truncation fast path.
    const displayText = self.input.buffer;
    const expandedText = Paste.expandPastePlaceholders(self, displayText);
    const attachments = [...self.attachments];
    const handler = self.onSubmit;
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
  // Streaming mode (default) — multi-message type-ahead queue. Commit the
  // current buffer to the pending-submission FIFO and clear the live input so
  // the user can immediately compose the NEXT message. Each committed message
  // drains as its own sequential turn when the surface flips to idle (see the
  // flush in setInputMode). The parent fires onSubmit per drained payload via
  // setInputMode('idle') (InputSurface, Stage 3b+).
  //
  // Payloads are self-contained: paste placeholders are expanded and
  // attachments snapshotted HERE (at commit), then the live pasteRegistry +
  // attachments are cleared. This decouples a queued message from later
  // live-buffer state — a subsequent paste/edit can't corrupt an already-
  // queued message. (Pre-multi-queue, Enter set a single `queued` flag and the
  // flush expanded the buffer lazily; commit-on-Enter moves expansion forward.)
  const displayText = self.input.buffer;
  const expandedText = Paste.expandPastePlaceholders(self, displayText);
  const attachments = [...self.attachments];
  const payload: SubmissionPayload =
    expandedText === displayText
      ? { text: expandedText, attachments }
      : { text: expandedText, displayText, attachments };
  // Invariant: after an ESC soft-stop, Enter must NOT accumulate a type-ahead
  // backlog. The teardown gap — the async window between ESC and the turn loop
  // actually breaking (for a subagent turn, cancelActiveForeground() in
  // subagent-executor.ts resolves the parent `await` only after the child
  // settles, seconds for a deep/wide wave) — keeps the compositor in 'streaming'
  // while the user, seeing no new turn, types a redirect and pokes ".". If each
  // Enter pushed its own FIFO entry, the queue would drain ONE payload per turn
  // (the `→ idle` flush), stranding the user one turn behind: the "it doesn't
  // send, then I keep sending characters to catch up" report — the lone-"."
  // messages. So across the whole post-ESC epoch, messages COALESCE into a
  // single payload that runs as exactly one next turn — no backlog.
  //
  // Epoch, not just the softStopped window. `postEscCoalesce` is armed at ESC
  // and held until the coalesced payload DRAINS (setInputMode's `→ idle` shift),
  // NOT cleared at the first teardown `→ idle` the way `softStopped` is. This
  // covers the residual #81/#403/#467 missed: a poke that lands AFTER teardown
  // (softStopped already false) but before the redirect visibly starts. It used
  // to strand as a separate turn; now it merges.
  //
  // Merge target by REFERENCE (`postEscPayload`), not a FIFO index. Any pre-ESC
  // payloads stay their own entries (handleEscape leaves postEscPayload null, so
  // they are never the merge target) and drain as their own sequential turns —
  // the handleEscape contract ("already-queued messages: left untouched") holds.
  // A reference survives those pre-ESC entries draining ahead of it, whereas the
  // old index (`softStopQueueBase`) went stale after any `shift()`.
  //
  // Merge joins texts with newlines + concatenates attachments (never last-wins,
  // which silently dropped earlier post-ESC messages — the #467 regression).
  // Normal mid-turn type-ahead (no ESC, postEscCoalesce === false) still
  // accumulates one payload per message: sequential-turn delivery is the intended
  // contract there (the "NO ESC" regression tests).
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
