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
  // Invariant: newline-insertion guards must run BEFORE any submit /
  //   queue / dropdown logic. They convert Enter into a literal
  //   `\n` insertion when the keystroke originated from pasted
  //   content or an explicit user request for a soft newline.
  //
  // 1. shift+Enter / alt+Enter -- explicit user intent for a soft newline.
  // 2. `self.pasting` -- between bracketed-paste markers.
  if (isSoftNewlineEnter(key, sequence)) {
    self.history?.resetRecall();
    self.applyEdit(InputCore.insert(self.input, '\n'));
    return true;
  }
  if (self.pasting) {
    self.input = InputCore.insert(self.input, '\n');
    self.queued = self.pendingSubmissions.length > 0;
    return true;
  }
  // Dropdown-open: apply the highlighted candidate before any
  // submit/queue path runs.
  const ac = self.autocompleteState;
  if (ac?.dropdownOpen) {
    const kind = ac.trigger?.kind;
    const applied = self.applyDropdownSelection();
    if (kind !== 'slash') return true;
    if (!applied) return true;
    // Slash + applied: fall through with the now-completed buffer.
  }
  // Trailing backslash escapes Enter -> convert to a real newline.
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
  // Allow Enter to submit attachment-only messages (empty text + >=1 image).
  if (self.input.buffer.length === 0 && self.attachments.length === 0) return true;
  // Idle mode: Enter resolves onSubmit immediately.
  if (self.inputMode === 'idle' && self.onSubmit) {
    const displayText = self.input.buffer;
    const expandedText = Paste.expandPastePlaceholders(self, displayText);
    const attachments = [...self.attachments];
    const handler = self.onSubmit;
    // Clear local state BEFORE invoking the handler so a reentrant
    // call does not double-fire or race a stale buffer.
    self.queued = self.pendingSubmissions.length > 0;
    self.input = InputCore.seed('');
    self.attachments = [];
    self.pasteRegistry.clear();
    // Reset autocomplete before repainting so dropdown chrome from
    // this input turn does not bleed into the echo-commit frame.
    self.autocompleteState?.reset();
    self.repaint();
    handler(
      expandedText === displayText
        ? { text: expandedText, attachments }
        : { text: expandedText, displayText, attachments },
    );
    return true;
  }
  // Streaming mode (default) -- multi-message type-ahead queue.
  const displayText = self.input.buffer;
  const expandedText = Paste.expandPastePlaceholders(self, displayText);
  const attachments = [...self.attachments];
  const payload: SubmissionPayload =
    expandedText === displayText
      ? { text: expandedText, attachments }
      : { text: expandedText, displayText, attachments };
  // Invariant: after an ESC soft-stop, Enter must NOT accumulate a type-ahead
  // backlog. Across the whole post-ESC epoch, messages COALESCE into a single
  // payload that runs as exactly one next turn -- no backlog.
  //
  // Invariant: while the coalesce epoch is armed, `postEscPayload` is either
  // null (no target committed yet this epoch) OR a reference that is PRESENT
  // in `pendingSubmissions`. Every site that removes the tracked payload
  // clears this reference -- with DELIBERATELY asymmetric epoch semantics that
  // must NOT be collapsed into one shared helper:
  //   * up-recall pop (handleVerticalNav) clears `postEscPayload` ONLY.
  //   * drain shift (input-mode `-> idle`) clears BOTH.
  //   * resetState clears everything on disarm/rearm.
  if (self.postEscCoalesce) {
    const target = self.postEscPayload;
    const idx = target !== null ? self.pendingSubmissions.indexOf(target) : -1;
    if (target !== null && idx >= 0) {
      // Live target present -- merge in place (same FIFO slot).
      const merged = mergeSubmissionPayloads([target, payload]);
      self.pendingSubmissions[idx] = merged;
      self.postEscPayload = merged;
    } else {
      // Either the first message this epoch (target === null -- the normal case)
      // or, under a FUTURE invariant violation, a dangling reference. Fail loud
      // in dev/test so CI catches the offending removal site.
      if (target !== null && env.NODE_ENV !== 'production') {
        throw new Error(
          'terminal-compositor: post-ESC coalesce reference is dangling ' +
            '(postEscPayload non-null but absent from pendingSubmissions) -- a ' +
            'pendingSubmissions removal site failed to clear the epoch reference.',
        );
      }
      self.postEscPayload = payload;
      self.pendingSubmissions.push(payload);
    }
  } else {
    // Normal mid-turn type-ahead (no ESC, postEscCoalesce === false).
    self.pendingSubmissions.push(payload);
  }
  self.queued = true;
  self.input = InputCore.seed('');
  self.attachments = [];
  self.pasteRegistry.clear();
  self.history?.resetRecall();
  self.autocompleteState?.reset();
  self.repaint();
  // Usage-limit pause escape: while the turn is parked waiting for auto-resume,
  // fire the pause-interrupt so the wait ends and the committed payload drains.
  if (self.paused && self.onPauseInterrupt) self.onPauseInterrupt();
  return true;
}
