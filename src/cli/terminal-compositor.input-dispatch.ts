/**
 * Input dispatch — the ordered keypress guard-chain (`dispatchKey`) and its 12
 * leaf handlers (picker, bracketed-paste markers, ESC soft-stop, Ctrl+C
 * interrupt, Ctrl+V clipboard image, vertical nav / history recall, Enter,
 * Backspace, cursor/edit bindings, Ctrl+B background, Tab, printable) —
 * extracted from terminal-compositor.ts. Follows the free-functions-on-host
 * pattern used by the sibling paste/autocomplete/render/committed-band modules:
 * the TerminalCompositor owns all input state; these functions read and MUTATE
 * the narrow {@link KeyDispatchHost} slice it passes as `self`. No behavior
 * change — bodies are byte-for-byte moves with `this.` rewritten to `self.`,
 * the intra-cluster handler calls in `dispatchKey` made direct module calls,
 * and `Autocomplete.MAX_DROPDOWN_ROWS` imported as the bare named const.
 *
 * The handlers are pure leaves — only `dispatchKey` calls them, in a fixed
 * priority order that IS the input contract (see the Invariant in dispatchKey).
 * The class keeps a one-line `dispatchKey` delegator so the keypress listener
 * installed in `arm()` is unchanged; everything below moved here.
 */

import { InputCore, type InputCoreState } from './input-core.js';
import { nextGraphemeIndex } from './display.js';
import { readClipboardImage } from './input/clipboard-image.js';
import { MAX_DROPDOWN_ROWS } from './terminal-compositor.autocomplete.js';
import * as Paste from './terminal-compositor.paste.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { IHistoryRing } from './input/types.js';
import type { ImageAttachment } from './input/attachments.js';
import type {
  CompositorInputMode,
  KeyInfo,
  PickerController,
  SubmissionPayload,
} from './terminal-compositor.types.js';

/**
 * Narrowest TerminalCompositor state slice the input-dispatch functions touch.
 * Buffer/flag/paste fields are mutated in place; `repaint`/`applyEdit`/
 * `updateAutocomplete`/`applyDropdownSelection`/`applyGhostAccept` are class
 * methods the handlers call back into. Field mutability mirrors the writes the
 * handlers perform — e.g. `attachments` is reassignable (handleEnter clears it
 * with `= []`), `pasteStartCursor` is written (handlePasteMarkers), while
 * read-only collaborators (`history`, the `on*` handlers, `activeGhost`,
 * `autocompleteState`) keep a readonly reference (their objects are still
 * mutated/invoked through it).
 */
export interface KeyDispatchHost {
  /** Re-render the live frame. */
  repaint(): void;
  /** Apply a pure InputCore transition (clears queued, refreshes autocomplete/ghost, repaints). */
  applyEdit(next: InputCoreState): boolean;
  /** Recompute autocomplete dropdown state for the current buffer. */
  updateAutocomplete(): void;
  /** Refresh the active ghost suggestion for the current buffer (Tier-1 sync + Tier-2 async kick-off). */
  updateGhost(): void;
  /** Apply the highlighted dropdown candidate; false when the dropdown is closed/empty. */
  applyDropdownSelection(): boolean;
  /** Accept the active ghost text; false when no ghost is showing. */
  applyGhostAccept(): boolean;

  /** Whether the compositor holds raw mode + a keypress listener (dispatch gate). */
  readonly armed: boolean;
  /** Live input buffer state. */
  input: InputCoreState;
  /** Whether the buffer is queued for submission on the next idle transition. */
  queued: boolean;
  /** Input mode — `'streaming'` | `'idle'` | `'picker'`. */
  readonly inputMode: CompositorInputMode;
  /** Active picker controller (non-null iff inputMode === 'picker'). */
  readonly pickerController: PickerController | null;

  /** Bracketed-paste burst guard (between `\x1b[200~` and `\x1b[201~`). */
  pasting: boolean;
  /** Buffer length snapshotted at bracketed-paste start. */
  pasteStartBufferLen: number;
  /** Insertion cursor snapshotted at bracketed-paste start. */
  pasteStartCursor: number;
  /** Side-table mapping placeholder id → original pasted content. */
  readonly pasteRegistry: Map<string, string>;

  /** Guard against concurrent osascript clipboard probes. */
  clipboardInFlight: boolean;
  /** Paint-clear notice surfaced when a clipboard probe found no image. */
  clipboardFailureMsg: string | null;
  /** Image attachments accumulated this compose window (reassigned on submit). */
  attachments: ImageAttachment[];

  /** Autocomplete dropdown/ghost state — mutated in place; reference is readonly. */
  readonly autocompleteState?: AutocompleteState;
  /** Currently active ghost string (buffer is a prefix of it). */
  readonly activeGhost: string | null;
  /** History ring for ↑/↓ recall; reference is readonly. */
  readonly history?: IHistoryRing;

  /** Once-only soft-stop guard for ESC in streaming mode. */
  softStopped: boolean;
  /** Hard-abort flag set by Ctrl+C in streaming mode. */
  canceled: boolean;
  /** Once-only guard for Ctrl+B background in streaming mode. */
  backgrounded: boolean;
  /** True while the turn is parked in a usage-limit pause — see {@link TerminalCompositor.paused}. */
  paused: boolean;

  /** Per-turn handlers (read + invoked; the class owns reassignment between turns). */
  readonly onCancel?: () => void;
  readonly onSoftStop?: () => void;
  readonly onBackground?: () => void;
  /** Submitted-line-during-pause handler — see {@link TerminalCompositorOptions.onPauseInterrupt}. */
  readonly onPauseInterrupt?: () => void;
  readonly onShiftTab?: () => void;
  readonly onSubmit?: (payload: SubmissionPayload) => void;
}

/**
 * Apply a pure InputCore transition. If the state reference changed, clear the
 * queued flag, refresh autocomplete + ghost, and repaint; otherwise it's a
 * no-op (e.g. moveLeft at 0). Returns whether the state reference changed.
 */
export function applyEdit(self: KeyDispatchHost, next: InputCoreState): boolean {
  if (next === self.input) return false;
  self.input = next;
  self.queued = false;
  // During a bracketed-paste burst, suppress per-character work —
  // a 10KB paste would otherwise trigger 10K log-update frames AND
  // 10K detectTrigger scans. The paste end marker (`\x1b[201~`)
  // runs maybeTruncatePaste + one final repaint, which also picks
  // up any autocomplete state from the final buffer. Mirrors the
  // `pasting` guard in reader.ts and keeps multi-KB pastes responsive.
  if (self.pasting) return true;
  self.updateAutocomplete();
  // Ghost-text update: synchronous Tier-1 check + async Tier-2 kick-off.
  // Paste bursts already returned early above (the `if (self.pasting)`
  // guard), so this per-character ghost refresh never fires mid-paste —
  // it would be stale by paste end anyway.
  self.updateGhost();
  self.repaint();
  return true;
}

export function dispatchKey(self: KeyDispatchHost, char: string | undefined, key: KeyInfo): void {
  if (!self.armed) return;

  // Invariant: key handling is a strictly ordered chain of guard
  // clauses. Each handler returns `true` the moment it consumes the
  // key (mirroring the original method's per-branch `return`), and the
  // ORDER of the calls below IS the input contract — picker first,
  // paste markers before Enter (so a mid-paste `\r` is not submitted),
  // modifier-aware navigation before plain arrows, etc. Reordering
  // these calls changes input semantics. Each handler carries the
  // ordering rationale for its own branch inline.
  if (handlePickerKey(self, char, key)) return;

  const sequence = key?.sequence ?? '';
  if (handlePasteMarkers(self, sequence)) return;
  if (handleEscape(self, key)) return;
  if (handleInterrupt(self, key)) return;
  if (handleClipboardImageKey(self, key)) return;
  if (handleVerticalNav(self, key)) return;
  if (handleEnter(self, key, sequence)) return;
  if (handleBackspace(self, key)) return;
  if (handleCursorAndEdit(self, key)) return;
  if (handleBackground(self, key)) return;
  if (handleTab(self, key)) return;
  handlePrintable(self, char, key);
}

function handlePickerKey(self: KeyDispatchHost, char: string | undefined, key: KeyInfo): boolean {
  // ── Picker mode short-circuit ────────────────────────────────────
  //
  // Invariant: while a picker is active, every keystroke MUST route to
  // the picker (Up/Down navigate, Space toggles, Enter confirms, Esc
  // cancels). The buffer + autocomplete + Enter/Esc defaults below
  // are all suppressed — the picker owns the input region for its
  // lifetime. Even bracketed-paste markers are swallowed (pasting
  // text into a picker is meaningless and would otherwise leak into
  // the hidden buffer for the next non-picker turn).
  //
  // The short-circuit MUST sit before any other branch so e.g. ESC
  // is not intercepted by the dropdown-dismiss path (the dropdown
  // is force-closed at enterPickerMode so it can't be open here,
  // but defence-in-depth: ordering is the contract).
  if (self.inputMode === 'picker' && self.pickerController) {
    self.pickerController.onKey(char, key);
    return true;
  }
  return false;
}

function handlePasteMarkers(self: KeyDispatchHost, sequence: string): boolean {
  // ── Bracketed paste markers ──────────────────────────────────────
  //
  // Most modern terminals send `\x1b[200~ ... \x1b[201~` around a
  // paste so the app can distinguish typed input from clipboard
  // content. Ported from reader.ts:380-430 — same image-detection
  // logic so Cmd+V on a clipboard image "just works": the paste
  // window arrives with zero characters (image bytes have no text
  // representation), and we speculatively probe the clipboard with
  // osascript to pull the image out.
  //
  // The non-empty paste branch also probes the clipboard — Finder's
  // copy puts both text and image on the pasteboard simultaneously,
  // so a "just text" paste shouldn't drop the image silently.
  if (sequence === '\x1b[200~') {
    self.pasting = true;
    self.pasteStartBufferLen = self.input.buffer.length;
    // Snapshot the cursor so the end marker can slice out the
    // pasted span. During paste, the cursor only advances (one
    // grapheme per inserted char + one per `\n`); nothing edits
    // chars before pasteStartCursor.
    self.pasteStartCursor = self.input.cursor;
    return true;
  }
  if (sequence === '\x1b[201~') {
    self.pasting = false;
    const probeClipboard = (onMissing: 'silent' | 'flag-missing') => {
      if (self.clipboardInFlight) return;
      self.clipboardInFlight = true;
      readClipboardImage().then((img) => {
        if (img) {
          self.clipboardFailureMsg = null;
          self.attachments.push(img);
          self.repaint();
        } else if (onMissing === 'flag-missing') {
          self.clipboardFailureMsg = '[clipboard: no image found]';
          self.repaint();
        }
      }).catch(() => { /* ignore — best-effort clipboard probe */ })
        .finally(() => { self.clipboardInFlight = false; });
    };
    if (self.input.buffer.length === self.pasteStartBufferLen) {
      // Zero-char paste = image-only clipboard. Surface "no image"
      // notice if the probe finds nothing, since the user clearly
      // tried to paste SOMETHING.
      probeClipboard('flag-missing');
    } else {
      // Non-empty paste — collapse oversized pastes into a compact
      // `[Pasted text #N +M lines]` placeholder BEFORE the first
      // post-paste repaint so the user never sees the full multi-KB
      // span flash in the input row. The placeholder is plain text
      // in the buffer (cursor math works the usual way); the full
      // content rides in pasteRegistry and is re-expanded at submit.
      Paste.maybeTruncatePaste(self);
      // Recompute autocomplete against the post-paste buffer (which may
      // now hold a collapsed placeholder) BEFORE the single post-paste
      // repaint. applyEdit suppresses updateAutocomplete during the paste
      // burst and maybeTruncatePaste mutates self.input directly, so
      // without this a dropdown opened before the paste (e.g. a slash
      // menu) would render stale until the next keystroke.
      self.updateAutocomplete();
      self.repaint();
      // Speculatively probe in case Finder put both text AND image
      // on the pasteboard. Silent on miss; the text pasted normally,
      // no need to surface a clipboard error.
      probeClipboard('silent');
    }
    return true;
  }
  return false;
}

function handleEscape(self: KeyDispatchHost, key: KeyInfo): boolean {
  if (key?.name !== 'escape') return false;
  const ac = self.autocompleteState;
  // ESC: close dropdown if open. In streaming mode, fire soft-stop
  // (once-only per turn via `softStopped` guard) — ESC is the
  // user-recoverable stop that preserves already-completed work. In
  // idle mode, ESC is reserved for UI dismissal only.
  //
  // ESC vs Ctrl+C: both now stop a turn gracefully (Ctrl+C routes to
  // onCancel → handleSigint, whose in-turn branch triggers the SAME
  // soft-stop as ESC), but they reach it by different paths and Ctrl+C
  // additionally arms the "press again to exit" window so a second
  // Ctrl+C quits. ESC routes straight to `onSoftStop`; it does NOT arm
  // the exit window and does NOT touch `canceled`, so a lone ESC never
  // edges the REPL toward quitting. The `canceled` flag is only the
  // compositor's once-only guard for the Ctrl+C branch below; it is not
  // read by the turn handler (soft-stop vs completed-turn is decided by
  // the turn handler's `softStopRequested`, which BOTH paths now set).
  if (ac?.dropdownOpen) {
    // Dismiss dropdown and record the suppression signature so it
    // stays closed until the buffer changes. Do NOT `return` here:
    // ghost-text autocomplete repopulates `dropdownOpen` on nearly every
    // keystroke, so while the agent streams the dropdown is almost always
    // open at the moment the user hits ESC to stop it. Returning early
    // swallowed that ESC and forced a second press to reach the soft-stop
    // path below — the "double-press to cancel" bug. Falling through lets a
    // single ESC both dismiss the dropdown AND fire soft-stop in streaming
    // mode; the idle-mode guard on the next line still keeps ESC a pure
    // UI-dismissal when not streaming, and the `softStopped` once-only guard
    // still prevents a second ESC from re-firing onSoftStop.
    ac.suppressedSignature = `${self.input.cursor}:${self.input.buffer}`;
    ac.dropdownOpen = false;
    ac.candidates = [];
    self.repaint();
  }
  if (self.inputMode === 'idle') return true;
  // Soft-stop: once-only per turn. Second ESC while streaming is
  // a no-op — the stream is already halting.
  if (self.softStopped) return true;
  // Contract: ESC soft-stop does NOT touch the buffer's queued state.
  // Enter is the ONLY queue trigger. So:
  //   - queued === true  (user pressed Enter): left untouched. It
  //     auto-submits as the next turn via the idle-transition flush
  //     (setInputMode → idle), since that branch fires on `queued`.
  //   - queued === false (user only TYPED, no Enter): stays an editable
  //     draft. The text is NOT dropped — setInputMode no longer
  //     de-queues and never clears the buffer, so the typed characters
  //     persist into the idle input row and simply wait for an explicit
  //     Enter. This is the "ESC with nothing queued leaves what I typed
  //     in the input field" behavior.
  // We deliberately do NOT auto-queue a typed-but-unconfirmed buffer
  // here: queuing it would fling it as a turn the user never submitted.
  // (Ctrl+C keeps the legacy auto-queue in handleInterrupt below —
  // hard-abort has intentionally different semantics.)
  self.softStopped = true;
  if (self.onSoftStop) self.onSoftStop();
  return true;
}

function handleInterrupt(self: KeyDispatchHost, key: KeyInfo): boolean {
  // Ctrl+C → onCancel (= the REPL's handleSigint), in any mode. The
  // first/second-press dispatch lives in handleSigint:
  //   - 1st Ctrl+C during a turn = ESC soft-stop (stop cleanly, keep
  //     work, preserve the draft); 2nd within the exit window quits.
  //   - In idle, 1st arms the exit window, 2nd quits.
  // We deliberately do NOT auto-queue the buffer here (parity with ESC
  // soft-stop, handleEscape): a graceful stop must leave a typed-but-
  // unconfirmed buffer as an editable draft (queued stays as-is), not
  // fling it as a turn the user never submitted. `canceled` stays a
  // once-only guard so a flurry of presses inside ONE streaming turn
  // fires onCancel once; the second quit-press arrives in idle (the
  // turn ends on interrupt) where the guard does not apply.
  if (key?.ctrl && key?.name === 'c') {
    if (self.inputMode === 'idle') {
      if (self.onCancel) self.onCancel();
      return true;
    }
    if (self.canceled) return true;
    self.canceled = true;
    if (self.onCancel) self.onCancel();
    return true;
  }
  return false;
}

function handleClipboardImageKey(self: KeyDispatchHost, key: KeyInfo): boolean {
  // Ctrl+V: explicit "read clipboard image" — alternative to Cmd+V
  // for users on terminals where bracketed-paste is disabled or who
  // prefer the keyboard binding. Ported from reader.ts:464-479.
  // In-flight guard prevents concurrent osascript spawns from key
  // repeats. schedulePaint() in reader.ts is replaced here by
  // self.repaint() because the compositor's log-update frame is
  // burst-coalesced internally.
  if (key?.ctrl && key?.name === 'v') {
    if (!self.clipboardInFlight) {
      self.clipboardInFlight = true;
      readClipboardImage().then((img) => {
        if (img) {
          self.clipboardFailureMsg = null;
          self.attachments.push(img);
        } else {
          self.clipboardFailureMsg = '[clipboard: no image found]';
        }
        self.repaint();
      }).catch(() => { /* ignore */ })
        .finally(() => { self.clipboardInFlight = false; });
    }
    return true;
  }
  return false;
}

function handleVerticalNav(self: KeyDispatchHost, key: KeyInfo): boolean {
  const ac = self.autocompleteState;
  // Invariant: dropdown nav direction is coupled to the REVERSED render
  // order in renderDropdownRows() (terminal-compositor.render.ts), which
  // pins the input at the bottom and grows the dropdown UPWARD — so
  // candidate index 0 renders at the BOTTOM (closest to the input) and
  // higher indices ascend visually away from it. To make the arrow keys
  // move the highlight in the direction the user presses, ↑ must move the
  // selection toward HIGHER indices (visually up, away from input) and ↓
  // toward LOWER indices (visually down, toward input). That is why ↑
  // increments and ↓ decrements here — the inverse of a conventional
  // top-anchored list. If you "simplify" ↑ back to a decrement, navigation
  // becomes visually flipped again (↓ appears to move up). The history
  // fallbacks below (dropdown closed) keep their conventional mapping:
  // ↑ recalls older entries, ↓ advances to newer ones.
  //
  // ↑ / Ctrl+P: move the highlight UP the dropdown (higher index), or
  // recall history when the dropdown is closed.
  if ((key?.ctrl && key?.name === 'p') || key?.name === 'up') {
    if (ac?.dropdownOpen) {
      if (ac.selectedIndex < ac.candidates.length - 1) {
        ac.selectedIndex++;
        if (ac.selectedIndex >= ac.viewportStart + MAX_DROPDOWN_ROWS) {
          ac.viewportStart = ac.selectedIndex - MAX_DROPDOWN_ROWS + 1;
        }
        self.repaint();
      }
      return true;
    }
    // History recall (↑) — only when history is wired in.
    // External constraint: a recalled buffer must enter the same edit
    // lifecycle as a typed character so `self.queued` is cleared. If we
    // skip applyEdit and inline-assign self.input here, a queued flag from
    // an earlier Enter survives the recall — the next Enter (or the next
    // turn boundary) then auto-submits the recalled text the user never
    // committed. Route through applyEdit() so queued is reset alongside
    // the autocomplete refresh and repaint.
    if (self.history) {
      const recalled = self.history.back(self.input.buffer);
      if (recalled !== null) {
        self.applyEdit(InputCore.seed(recalled));
      }
    }
    return true;
  }

  // ↓ / Ctrl+N: move the highlight DOWN the dropdown (lower index, toward
  // the input — see the geometry Invariant on the ↑ branch above), or
  // advance history when the dropdown is closed.
  if ((key?.ctrl && key?.name === 'n') || key?.name === 'down') {
    if (ac?.dropdownOpen) {
      if (ac.selectedIndex > 0) {
        ac.selectedIndex--;
        if (ac.selectedIndex < ac.viewportStart) ac.viewportStart = ac.selectedIndex;
        self.repaint();
      }
      return true;
    }
    // History forward (↓) — only when history is wired in. See ↑ branch
    // for the queued-flag invariant; applyEdit() resets it.
    if (self.history) {
      const recalled = self.history.forward();
      if (recalled !== null) {
        self.applyEdit(InputCore.seed(recalled));
      }
    }
    return true;
  }
  return false;
}

function handleEnter(self: KeyDispatchHost, key: KeyInfo, sequence: string): boolean {
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
  const isShiftEnter = key?.shift === true || sequence === '\x1b[13;2u';
  const isAltEnter = key?.meta === true;
  if (isShiftEnter || isAltEnter) {
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
    // over the final buffer. queued must be cleared because any
    // buffer mutation invalidates a prior Enter-queued state.
    self.input = InputCore.insert(self.input, '\n');
    self.queued = false;
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
    self.queued = false;
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
  // Streaming mode (default) — today's behavior. Set queued; parent
  // fires onSubmit via setInputMode('idle') (InputSurface, Stage 3b+).
  // Note: the submit flush reads self.input.buffer directly — not via
  // getBuffer() — so pasteRegistry is still populated when expansion runs.
  if (!self.queued) {
    self.queued = true;
    self.repaint();
  }
  // Usage-limit pause escape: while the turn is parked waiting for auto-resume
  // (the loop is suspended in `await runTurn`), a queued line would otherwise
  // sit stranded behind the wait. Fire the pause-interrupt so the wait ends
  // (handler calls session.interrupt) and the buffer we just queued flushes as
  // the NEXT turn via the idle-transition flush — the same path ESC uses.
  // Ordering: queue is set ABOVE, then we interrupt (teardown-before-setup), so
  // the next readLine()'s setInputMode('idle') dispatches the buffer. Reached
  // only past the empty-buffer suppression above, so there is always content to
  // run; idempotent if the user presses Enter twice (interrupt is idempotent).
  if (self.paused && self.onPauseInterrupt) self.onPauseInterrupt();
  return true;
}

function handleBackspace(self: KeyDispatchHost, key: KeyInfo): boolean {
  if (key?.name !== 'backspace') return false;
  // Option+Delete on macOS → meta+backspace: delete previous word.
  // Mirrors reader.ts:677 so word-erase is consistent across both
  // input surfaces.
  if (key?.meta) {
    const next = InputCore.deleteWordBackward(self.input);
    if (next !== self.input) {
      self.history?.resetRecall();
      self.applyEdit(next);
    }
    return true;
  }
  // Atomic placeholder delete — when the cursor sits at the
  // trailing `]` of a `[Pasted text #N +M lines]` token, single
  // Backspace removes the whole token (and drops the side-table
  // entry). Without this, deleting a freshly-pasted blob requires
  // ~30 backspaces. Run BEFORE the InputCore.backspace fallback
  // so the atomic path wins when both would fire.
  const atomic = Paste.maybeAtomicPlaceholderDelete(self, 'backward');
  if (atomic) {
    self.history?.resetRecall();
    self.applyEdit(atomic);
    return true;
  }
  const next = InputCore.backspace(self.input);
  if (next !== self.input) {
    self.history?.resetRecall();
    self.applyEdit(next);
  } else if (self.queued) {
    // Cursor at 0 but was queued — Backspace just unqueues.
    self.queued = false;
    self.repaint();
  } else if (self.attachments.length > 0) {
    // Buffer empty + attachments present — pop the last attachment.
    // Ported from reader.ts:668. Lets the user "undo" an
    // accidental clipboard paste without retyping.
    self.attachments.pop();
    self.repaint();
  }
  return true;
}

function handleCursorAndEdit(self: KeyDispatchHost, key: KeyInfo): boolean {
  // ── Word/line navigation (readline parity) ───────────────────────
  //
  // Invariant: modifier-aware navigation bindings MUST be dispatched
  // before the plain `left`/`right` handlers below. The plain
  // handlers match on `name === 'left'/'right'` regardless of
  // modifiers, so meta/ctrl-modified arrows would otherwise be
  // shadowed and never reach the word-nav code.
  //
  // Contract: every binding in this block is a pure cursor/edit op
  // delegated to InputCore. Detection by `(modifier, name)` mirrors
  // the dormant `reader.ts` fallback so behavior is consistent across
  // both input surfaces. Node's readline parser maps modified arrows
  // and Esc-prefixed letters as documented inline below.
  //
  // Buffer-modifying ops call `history?.resetRecall()` before
  // `applyEdit` (same convention as the existing backspace/delete
  // branches). Pure cursor moves rely on `applyEdit`'s identity
  // check to no-op at buffer edges.

  // Cmd+← (terminal default remap on Terminal.app & iTerm2 sends
  // \x01 = Ctrl+A) / Ctrl+A → move to start of current logical line.
  if (key?.ctrl && key?.name === 'a') {
    self.applyEdit(InputCore.moveLineStart(self.input));
    return true;
  }

  // Cmd+→ (default remap → \x05 = Ctrl+E) / Ctrl+E → line end.
  if (key?.ctrl && key?.name === 'e') {
    self.applyEdit(InputCore.moveLineEnd(self.input));
    return true;
  }

  // Option+← (xterm CSI 1;3D → meta+left) / Cmd+← when terminal sends
  // CSI 1;9D (also parsed as meta+left by Node) / Ctrl+← (CSI 1;5D,
  // cross-platform word-back convention) → word backward.
  if ((key?.meta || key?.ctrl) && key?.name === 'left') {
    self.applyEdit(InputCore.moveWordBackward(self.input));
    return true;
  }

  // Option+→ / Cmd+→ (CSI 1;9C) / Ctrl+→ → word forward.
  if ((key?.meta || key?.ctrl) && key?.name === 'right') {
    self.applyEdit(InputCore.moveWordForward(self.input));
    return true;
  }

  // Option+B / Alt+B (Esc-prefixed, "Use Option as Meta" mode) → word back.
  if (key?.meta && key?.name === 'b') {
    self.applyEdit(InputCore.moveWordBackward(self.input));
    return true;
  }

  // Option+F / Alt+F → word forward.
  if (key?.meta && key?.name === 'f') {
    self.applyEdit(InputCore.moveWordForward(self.input));
    return true;
  }

  // Ctrl+W → delete word backward (readline `backward-kill-word`).
  if (key?.ctrl && key?.name === 'w') {
    const next = InputCore.deleteWordBackward(self.input);
    if (next !== self.input) {
      self.history?.resetRecall();
      self.applyEdit(next);
    }
    return true;
  }

  // Ctrl+U → delete from cursor to start of current line
  // (readline `backward-kill-line`). Also fires on Cmd+Delete in
  // iTerm2 profiles that remap it to ^U.
  if (key?.ctrl && key?.name === 'u') {
    const next = InputCore.deleteToLineStart(self.input);
    if (next !== self.input) {
      self.history?.resetRecall();
      self.applyEdit(next);
    }
    return true;
  }

  // Ctrl+K → delete from cursor to end of current line
  // (readline `kill-line`). Symmetric counterpart to Ctrl+U.
  if (key?.ctrl && key?.name === 'k') {
    const next = InputCore.deleteToLineEnd(self.input);
    if (next !== self.input) {
      self.history?.resetRecall();
      self.applyEdit(next);
    }
    return true;
  }

  if (key?.name === 'left') {
    self.applyEdit(InputCore.moveLeft(self.input));
    return true;
  }

  if (key?.name === 'right') {
    // When cursor is already at end-of-buffer and a ghost is showing,
    // Right-arrow accepts the ghost instead of doing a no-op cursor move.
    // Mid-buffer Right-arrow keeps its normal cursor-advance behavior.
    if (
      self.input.cursor === self.input.buffer.length &&
      self.activeGhost !== null &&
      !self.autocompleteState?.dropdownOpen
    ) {
      self.applyGhostAccept();
    } else {
      self.applyEdit(InputCore.moveRight(self.input));
    }
    return true;
  }

  if (key?.name === 'home') {
    self.applyEdit(InputCore.moveHome(self.input));
    return true;
  }

  if (key?.name === 'end') {
    self.applyEdit(InputCore.moveEnd(self.input));
    return true;
  }

  if (key?.name === 'delete') {
    // Option+Fn-Delete → meta+delete: delete next word.
    if (key?.meta) {
      const next = InputCore.deleteWordForward(self.input);
      if (next !== self.input) {
        self.history?.resetRecall();
        self.applyEdit(next);
      }
      return true;
    }
    // Atomic placeholder delete (forward) — symmetric counterpart
    // to the backspace branch above. When the cursor sits at the
    // leading `[` of a placeholder, Delete removes the whole
    // token.
    const atomic = Paste.maybeAtomicPlaceholderDelete(self, 'forward');
    if (atomic) {
      self.history?.resetRecall();
      self.applyEdit(atomic);
      return true;
    }
    self.history?.resetRecall();
    self.applyEdit(InputCore.deleteForward(self.input));
    return true;
  }
  return false;
}

function handleBackground(self: KeyDispatchHost, key: KeyInfo): boolean {
  // Ctrl+B → background current turn. Streaming-mode only — there's
  // no turn to background between turns. Once-only guard prevents
  // double-fire within a single streaming session; the
  // idle→streaming transition resets it (see setInputMode).
  if (key?.ctrl && key?.name === 'b') {
    if (self.inputMode === 'idle') return true;
    if (self.backgrounded) return true;
    self.backgrounded = true;
    if (self.onBackground) self.onBackground();
    return true;
  }
  return false;
}

function handleTab(self: KeyDispatchHost, key: KeyInfo): boolean {
  // Tab applies the highlighted dropdown candidate. When no dropdown is
  // open, Tab is swallowed (we deliberately do NOT insert a literal tab
  // into the buffer — matches reader.ts:769-772 behavior).
  //
  // Shift+Tab fires onShiftTab. The persistent InputSurface installs
  // this once at REPL start to toggle plan mode (reader.ts's historic
  // binding) — works in both idle and streaming modes since plan
  // mode is REPL-global, not turn-scoped.
  if (key?.name === 'tab' && key?.shift) {
    if (self.onShiftTab) self.onShiftTab();
    return true;
  }
  if (key?.name === 'tab') {
    // Precedence: dropdown first (existing behaviour), ghost second.
    // `applyDropdownSelection` returns false when the dropdown is closed,
    // so we fall through to ghost-accept only when the dropdown was absent.
    if (!self.applyDropdownSelection()) {
      self.applyGhostAccept();
    }
    return true;
  }
  return false;
}

/**
 * True when `s` is a single printable grapheme cluster (one visual character):
 * not a control char (< ' '), and exactly one grapheme — so multi-UTF-16-unit
 * emoji (surrogate pairs, variation selectors, skin-tone modifiers) count as
 * one printable character, while escape sequences and multi-char fragments are
 * rejected. Replaces the old `s.length === 1` UTF-16 code-unit test that
 * silently dropped all astral / composed emoji.
 */
function isPrintableGrapheme(s: string): boolean {
  return s >= ' ' && nextGraphemeIndex(s, 0) === s.length;
}

function handlePrintable(self: KeyDispatchHost, char: string | undefined, key: KeyInfo): void {
  // Ignore remaining nav/modifier combos that aren't cancel-combos.
  const ignored = ['tab', 'pageup', 'pagedown'];
  if (key?.name && ignored.includes(key.name)) return;
  if (key?.ctrl || key?.meta) return;

  // Printable: prefer `char`; fall back to key.sequence when char is absent
  // (some terminals emit only sequence for certain keys). isPrintableGrapheme
  // admits multi-UTF-16-unit emoji that the old `length === 1` test dropped.
  const printable =
    typeof char === 'string' && isPrintableGrapheme(char)
      ? char
      : typeof key?.sequence === 'string' && isPrintableGrapheme(key.sequence)
        ? key.sequence
        : null;
  if (printable !== null) {
    self.history?.resetRecall();
    self.applyEdit(InputCore.insert(self.input, printable));
  }
}
