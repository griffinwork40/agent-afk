/**
 * Raw-mode TTY orchestrator for the autocomplete reader.
 *
 * Wires together:
 *   - raw-mode + bracketed-paste setup ({@link ./raw-mode.ts})
 *   - trigger detection + candidate filtering ({@link ./trigger.ts})
 *   - dropdown rendering ({@link ./dropdown.ts})
 *   - submit-echo + visual-row math ({@link ./echo.ts})
 *   - clipboard image attachments ({@link ./clipboard-image.ts})
 *
 * Owns the keypress event loop, the per-frame repaint, and the cursor
 * accounting. Public entry is `readWithAutocompleteTty`, called only after
 * the surrounding wrapper has decided we're on an interactive terminal.
 */

import { emitKeypressEventsImmediateEscape } from './emit-keypress.js';
import * as ansiEscapes from 'ansi-escapes';
import stringWidth from 'string-width';
import { list as listSlashCommands, aliasEntries } from '../slash/registry.js';
import { stripAnsi } from '../display.js';
import { acquireStdinClaim } from './stdin-claim.js';
import { InputCore, type InputCoreState } from '../input-core.js';
import { colorizeInputBuffer, type SlashRegistryView } from '../input-highlight.js';
import { describeAttachmentSummary, renderStatusLine, type ImageAttachment } from './attachments.js';
import { readClipboardImage } from './clipboard-image.js';
import { formatDropdownRow, formatHintRow } from './dropdown.js';
import { formatSubmittedEcho, visualCursorPos, visualRowCount } from './echo.js';
import { enterRawMode, type RawModeHandle } from './raw-mode.js';
import {
  detectTrigger,
  filterFileCandidates,
  filterFlagCandidates,
  filterSlashCandidates,
} from './trigger.js';
import { createAutocompleteState } from './autocomplete-state.js';
import { ResizeBus } from '../terminal-size.js';
import type {
  KeyInfo,
  ReadWithAutocompleteOpts,
  ReadWithAutocompleteResult,
} from './types.js';

export async function readWithAutocompleteTty(
  opts: ReadWithAutocompleteOpts,
): Promise<ReadWithAutocompleteResult> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  // Defensive raw-mode guard: if the compositor is already armed it owns raw
  // mode; entering raw mode again would double-set and confuse restoration.
  // In practice this guard never fires (compositor is always disarmed between
  // turns), but it is correct-by-default for future call sites.
  const compositorArmed = opts.compositor?.isArmed() ?? false;
  const rawMode: RawModeHandle = compositorArmed
    ? { restore: () => {} }
    : enterRawMode(stdin, stdout);

  // Stdin claim: acquire here so the single-consumer stdin invariant is
  // structurally enforced (see src/cli/input/stdin-claim.ts). Skip when the
  // compositor is already armed — it holds its own claim and this reader is
  // acting as a subordinate consumer under the compositor's keypress handler.
  const stdinClaim = compositorArmed
    ? null
    : acquireStdinClaim('reader.readWithAutocomplete');

  // Bottom-row reservation: increment extraRows by 1 so the DECSTBM scroll
  // region leaves space for the composer prompt. Captured + restored in the
  // finally block to be additive-safe (bgStatusBar may have already set
  // extraRows > 0).
  //
  // External constraint (raw-mode pairing): the +1 increment must happen
  // INSIDE the try so that any throw from `setExtraRows` still hits the
  // finally block and `rawMode.restore()` runs. Hoisting it above the try
  // would orphan raw-mode if `setExtraRows` ever throws.
  const priorExtraRows = opts.statusLine?.getExtraRows() ?? 0;

  // Lone ESC fires on the first press (small sub-perception escapeCodeTimeout)
  // instead of being buffered ~500ms for escape-sequence disambiguation. See
  // emit-keypress.ts.
  emitKeypressEventsImmediateEscape(stdin);

  const promptText = opts.promptFn();
  const promptVisibleLen = stringWidth(stripAnsi(promptText));

  let handleKeypress: ((char: string | undefined, key: KeyInfo) => void) | null = null;
  // ResizeBus.subscribe() returns an unsub fn; call it in cleanup() to detach
  // the subscriber without round-tripping through the listener reference
  // (avoids the "remove the wrong fn" footgun of the former stdout.on path).
  let resizeUnsub: (() => void) | null = null;

  try {
    opts.statusLine?.setExtraRows(priorExtraRows + 1);
    return await new Promise<ReadWithAutocompleteResult>((resolve, reject) => {
      let input: InputCoreState = InputCore.seed(opts.initialBuffer ?? '');
      // Use injected autocomplete state when provided (unified InputSurface);
      // otherwise fall back to a fresh local state (backward-compatible).
      // reset() is called here so any stale state from a prior agent-turn
      // (e.g. open dropdown that was never dismissed) does not leak in.
      const ac = opts.autocompleteState ?? createAutocompleteState();
      ac.reset();
      let rowsBelow = 0; // dropdown rows currently drawn below the input line
      let pasting = false; // bracketed paste mode: suppress repaint per-char
      let clipboardInFlight = false; // guard against concurrent osascript spawns on rapid Cmd+V / Ctrl+V
      let pasteStartBufferLen = 0; // buffer length at bracketed-paste start, used to detect image pastes (Cmd+V on a clipboard image yields zero text)
      let prevBufferRows = 0; // visual rows occupied by previous buffer render
      let prevStatusRows = 0; // status line rows (0 or 1)
      let clipboardFailureMsg: string | null = null; // ephemeral "no image found" notice; cleared on next repaint
      const attachments: ImageAttachment[] = [];
      const maxDropdownRows = 6;

      // Burst detection: coalesce rapid keypresses into a single repaint
      let lastKeypressAt = 0;
      let repaintPending = false;
      const PASTE_WINDOW_MS = 8;

      // Adapter for the slash highlighter — registered command names from
      // `listSlashCommands()` include the leading `/`, so we strip it before
      // membership-check so the highlighter (which passes the bare name)
      // matches correctly.
      const slashRegistryView: SlashRegistryView = {
        has: (name) => listSlashCommands().some((c) => c.name === `/${name}`),
      };

      /**
       * Fully redraw the input line (and optional dropdown) at whatever row the
       * cursor currently occupies. Preserves surrounding history — uses only
       * relative cursor motion and erase-from-cursor-to-end-of-screen.
       */
      const repaint = () => {
        // If the previous render spanned multiple rows (multi-line buffer) or had a status line,
        // move the cursor up to the top row of that render before clearing.
        if (prevStatusRows > 0 || prevBufferRows > 0) {
          stdout.write(ansiEscapes.cursorUp(prevStatusRows + prevBufferRows));
        }

        // Cursor is now at col 0 of the first row of the previous render.
        // Move to col 0 and erase everything below.
        stdout.write('\r');
        stdout.write(ansiEscapes.eraseDown);

        // Write status line: attachment summary, or ephemeral failure notice, or nothing.
        if (attachments.length > 0) {
          stdout.write(renderStatusLine(attachments) + '\n');
          prevStatusRows = 1;
        } else if (clipboardFailureMsg !== null) {
          // Paint-clear: consume and display the failure message exactly once.
          const msg = clipboardFailureMsg;
          clipboardFailureMsg = null;
          stdout.write(msg + '\n');
          prevStatusRows = 1;
        } else {
          prevStatusRows = 0;
        }

        // Write prompt + buffer (cursor ends at end-of-buffer on input line).
        // The slash highlighter wraps the leading `/<command>` token in ANSI
        // escapes (zero-width) — printable length is unchanged, so cursor math
        // below (`promptVisibleLen + input.cursor`) still works against the
        // uncolored buffer.
        stdout.write(promptText + colorizeInputBuffer(input.buffer, slashRegistryView));

        // Recompute trigger / candidates from current buffer + cursor.
        //
        // Suppression check: if the user just hit Escape, the dropdown stays
        // closed for as long as the (buffer, cursor) signature matches the
        // dismissed state. Any edit or cursor move produces a different
        // signature and re-arms autocomplete on the next paint.
        ac.trigger = detectTrigger(input.buffer, input.cursor);
        const currentSignature = `${input.cursor}:${input.buffer}`;
        if (ac.suppressedSignature !== null && ac.suppressedSignature !== currentSignature) {
          ac.suppressedSignature = null;
        }
        if (ac.trigger && ac.suppressedSignature === null) {
          if (ac.trigger.kind === 'slash') {
            ac.candidates = filterSlashCandidates(ac.trigger.query).slice(0, 12);
          } else if (ac.trigger.kind === 'file') {
            // File candidates are bounded upstream (MAX_FILE_MATCHES) and the
            // dropdown scrolls; do NOT re-cap to 12, or entries past the 12th
            // (e.g. src/, tests/ in a typical cwd) become unreachable.
            ac.candidates = filterFileCandidates(ac.trigger.query);
          } else {
            ac.candidates = filterFlagCandidates(ac.trigger.command, ac.trigger.query);
          }
          ac.dropdownOpen = ac.candidates.length > 0;
        } else {
          ac.dropdownOpen = false;
          ac.candidates = [];
        }
        if (ac.selectedIndex >= ac.candidates.length) ac.selectedIndex = Math.max(0, ac.candidates.length - 1);
        if (ac.viewportStart > ac.selectedIndex) ac.viewportStart = ac.selectedIndex;
        if (ac.selectedIndex >= ac.viewportStart + maxDropdownRows) {
          ac.viewportStart = ac.selectedIndex - maxDropdownRows + 1;
        }

        const cols = stdout.columns || 80;
        rowsBelow = 0;
        if (ac.dropdownOpen && cols > 40) {
          const maxWidth = Math.min(cols - 4, 60);
          const visibleCount = Math.min(ac.candidates.length - ac.viewportStart, maxDropdownRows);
          for (let i = 0; i < visibleCount; i++) {
            const idx = ac.viewportStart + i;
            const row = formatDropdownRow(ac.candidates[idx]!, idx === ac.selectedIndex, maxWidth, ac.trigger?.kind);
            stdout.write('\n' + row);
            // Each rendered row may itself wrap if the terminal is narrow
            // enough that the row's printable width exceeds `cols`. Count
            // soft-wrapped rows so eraseDown on the next repaint covers
            // every visible cell. ANSI escapes are zero-width — strip
            // before measuring.
            const rowWidth = stringWidth(stripAnsi(row));
            rowsBelow += Math.max(1, Math.ceil(rowWidth / cols));
          }

          // Tooltip row: "when to use" guidance for the highlighted candidate.
          // Only slash-command candidates carry hints today (file and flag
          // candidates leave `hint` undefined); formatHintRow returns null in
          // that case so no row is written and the dropdown collapses cleanly.
          //
          // Constraint: this row sits BELOW the dropdown — the cursor-return
          // math below uses `rowsBelow` as the total written-below count, so
          // every tooltip soft-wrap row must be folded into that total before
          // we compute the upward jump. Forgetting to update `rowsBelow` here
          // strands the cursor on the tooltip row on the next repaint.
          const hintWidth = Math.min(cols - 4, 80);
          const hintRow = formatHintRow(ac.candidates[ac.selectedIndex]?.hint, hintWidth);
          if (hintRow !== null) {
            stdout.write('\n' + hintRow);
            const hintRowWidth = stringWidth(stripAnsi(hintRow));
            rowsBelow += Math.max(1, Math.ceil(hintRowWidth / cols));
          }
        }

        // Return cursor to the input position within the rendered block.
        //
        // After writing prompt+buffer (+ optional dropdown), the terminal
        // cursor sits at the end of the last dropdown row — or at the end
        // of the buffer's last visual row if no dropdown. The cursor's
        // target visual (row, col) within the block is independent of the
        // natural end position when the user has arrow-keyed mid-buffer
        // OR the buffer wraps OR contains '\n'.
        //
        // Naive `\r` + cursorForward(promptW + cursor) is wrong here:
        // `\r` lands on the LAST visual row (post-wrap), not the prompt's
        // row, and cursorForward clamps at the right edge — so on every
        // soft-wrap the visible cursor jams against the screen edge
        // instead of tracking the typed text.
        //
        // Constraint: terminal cursor motion is row/column-relative; the
        // only known reference is the end-of-render position. Reconstruct
        // the target by computing visual (row, col) from the buffer +
        // cursor index, then navigate up from end-of-render.
        const newPrevBufferRows = visualRowCount(input.buffer, promptVisibleLen, cols);
        const { row: vRow, col: vCol } = visualCursorPos(
          input.buffer,
          input.cursor,
          promptVisibleLen,
          cols,
        );
        // End-of-render row offset from top of buffer block is
        // `newPrevBufferRows + rowsBelow`. Move up to land on vRow; clamp
        // at 0 to tolerate the deferred-wrap boundary where vRow can
        // briefly exceed newPrevBufferRows by one (cursor at the implicit
        // next row that hasn't been written yet).
        const upRows = Math.max(0, newPrevBufferRows - vRow + rowsBelow);
        if (upRows > 0) stdout.write(ansiEscapes.cursorUp(upRows));
        stdout.write('\r');
        if (vCol > 0) stdout.write(ansiEscapes.cursorForward(vCol));

        prevBufferRows = newPrevBufferRows;
      };

      // COR-1: guard against setImmediate firing after cleanup()+resolve().
      let settled = false;

      /**
       * Coalesce repaints during burst (rapid keypress) periods.
       * If a repaint is already pending, returns immediately.
       * Otherwise, schedules repaint on next setImmediate tick.
       */
      const schedulePaint = () => {
        if (repaintPending) return;
        repaintPending = true;
        setImmediate(() => {
          if (repaintPending && !settled) {
            repaintPending = false;
            repaint();
          }
        });
      };

      // Initial render: prompt + (empty) buffer on the current line.
      repaint();

      /**
       * Apply the currently highlighted dropdown selection to the buffer.
       * Returns `true` if a candidate was actually applied, `false` if there
       * was no candidate to apply (COR-2: callers gate submit on this return value).
       */
      const applySelection = (): boolean => {
        const selected = ac.candidates[ac.selectedIndex];
        if (!selected) return false;
        const upToCursor = input.buffer.slice(0, input.cursor);
        const afterCursor = input.buffer.slice(input.cursor);

        let start: number;
        let text: string;
        if (ac.trigger?.kind === 'slash') {
          const match = /\/[A-Za-z_-]*$/.exec(upToCursor);
          start = match ? upToCursor.length - match[0].length : input.cursor;
          text = selected.value + (afterCursor.startsWith(' ') ? '' : ' ');
        } else if (ac.trigger?.kind === 'flag') {
          // Replace the partial `--query` token at end-of-line with the selected flag.
          const match = /--[a-z0-9-]*$/.exec(upToCursor);
          start = match ? upToCursor.length - match[0].length : input.cursor;
          text = selected.value + (afterCursor.startsWith(' ') ? '' : ' ');
        } else {
          // Token boundary = start of trailing non-whitespace run (the `@token`).
          const tokenStart = upToCursor.search(/[^\s]*$/);
          start = tokenStart >= 0 ? tokenStart : input.cursor;
          text = selected.value;
        }

        input = InputCore.replaceRange(input, { start, end: input.cursor }, text);
        ac.dropdownOpen = false;
        ac.viewportStart = 0;
        ac.selectedIndex = 0;
        repaint();
        return true;
      };

      const onSubmit = () => {
        // Clear dropdown (if any) and leave the submitted input line as the last
        // visible row, with cursor on the next line for the caller's output.
        if (prevStatusRows > 0 || prevBufferRows > 0) {
          stdout.write(ansiEscapes.cursorUp(prevStatusRows + prevBufferRows));
        }
        // Erase everything below the cursor so any prior multi-line edit
        // state or dropdown chrome is cleared before the echo is rewritten.
        stdout.write('\r');
        stdout.write(ansiEscapes.eraseDown);
        rowsBelow = 0;
        // eraseDown above wipes the in-input `renderStatusLine` indicator, so
        // any attachment acknowledgment must be re-emitted as part of the
        // post-submit echo or the user loses all visual confirmation that an
        // image rode along with the turn.
        const echo = formatSubmittedEcho({
          buffer: colorizeInputBuffer(input.buffer, slashRegistryView),
          promptText,
          isTTY: Boolean(stdout.isTTY),
          attachmentSummary: describeAttachmentSummary(attachments),
        });
        // External constraint (DECSTBM contract): the StatusLine reserves the
        // bottom row via a persistent scroll region. A `\n` written at the
        // bottom of that sub-region triggers a sub-region scroll on
        // xterm/iTerm2/Apple Terminal and the displaced top line silently
        // exits without entering scrollback — meaning this echo can vanish
        // from the user's scroll history if subsequent turn output causes
        // enough cumulative sub-region scrolls. Route through the guard so
        // the write happens with full-screen scroll semantics, which DOES
        // enter scrollback. No-op when statusLine has no guard or hasn't
        // started (e.g. non-TTY test surfaces).
        const writeEcho = () => stdout.write(echo + '\n');
        if (opts.statusLine?.withFullScrollRegion) {
          opts.statusLine.withFullScrollRegion(writeEcho);
        } else {
          writeEcho();
        }
        cleanup();
        resolve({ text: input.buffer, attachments: [...attachments] });
        prevBufferRows = 0;
      };

      const onAbort = (err: Error) => {
        if (prevBufferRows > 0) {
          stdout.write(ansiEscapes.cursorUp(prevBufferRows));
        }
        if (rowsBelow > 0) {
          stdout.write(ansiEscapes.eraseDown);
          rowsBelow = 0;
        }
        stdout.write('\n');
        cleanup();
        reject(err);
        prevBufferRows = 0;
      };

      const cleanup = () => {
        settled = true; // COR-1: prevent queued setImmediate repaints after settle.
        if (handleKeypress) stdin.removeListener('keypress', handleKeypress);
        if (resizeUnsub) resizeUnsub();
        handleKeypress = null;
        resizeUnsub = null;
      };

      handleKeypress = (char: string | undefined, key: KeyInfo) => {
        // Track timing for burst detection (for fallback when bracketed paste is unavailable).
        const now = Date.now();
        const inBurst = (now - lastKeypressAt) < PASTE_WINDOW_MS;
        lastKeypressAt = now;

        // Bracketed paste mode: detect start marker (ESC [ 2 0 0 ~) and end marker (ESC [ 2 0 1 ~).
        // When pasting, `emitKeypressEvents` may expose these as key.sequence or key.code.
        const sequence = key?.sequence || '';
        if (sequence === '\x1b[200~') {
          pasting = true;
          pasteStartBufferLen = input.buffer.length;
          return;
        }
        if (sequence === '\x1b[201~') {
          pasting = false;
          // If the paste window inserted zero characters, the user almost
          // certainly hit Cmd+V on a clipboard that has image bytes (no text
          // representation, so the terminal sent an empty bracketed paste).
          // Speculatively probe the clipboard for image data — this makes
          // Cmd+V "just work" on macOS without forcing users to hit
          // literal Ctrl+V (which would bypass bracketed paste entirely).
          if (input.buffer.length === pasteStartBufferLen) {
            if (!clipboardInFlight) {
              clipboardInFlight = true;
              readClipboardImage().then((img) => {
                if (img) {
                  clipboardFailureMsg = null;
                  attachments.push(img);
                } else {
                  clipboardFailureMsg = '[clipboard: no image found]';
                }
                schedulePaint();
              }).catch(() => { /* ignore */ }).finally(() => {
                clipboardInFlight = false;
              });
            }
          } else {
            // Non-empty bracketed paste: repaint the text, but also speculatively
            // probe for a clipboard image in case the user copied from Finder
            // (which places both text and image data on the pasteboard simultaneously).
            repaint();
            if (!clipboardInFlight) {
              clipboardInFlight = true;
              readClipboardImage().then((img) => {
                if (img) {
                  clipboardFailureMsg = null;
                  attachments.push(img);
                  schedulePaint();
                }
              }).catch(() => { /* ignore */ }).finally(() => {
                clipboardInFlight = false;
              });
            }
          }
          return;
        }

        // Ctrl+C
        if (key?.ctrl && key?.name === 'c') {
          if (opts.onSigint) {
            opts.onSigint();
          } else {
            onAbort(new Error('SIGINT'));
          }
          return;
        }

        // Ctrl+D: EOF only when buffer is empty
        if (key?.ctrl && key?.name === 'd') {
          if (input.buffer.length === 0) {
            if (prevStatusRows > 0 || prevBufferRows > 0) {
              stdout.write(ansiEscapes.cursorUp(prevStatusRows + prevBufferRows));
            }
            if (rowsBelow > 0) {
              stdout.write(ansiEscapes.eraseDown);
              rowsBelow = 0;
            }
            stdout.write('\n');
            cleanup();
            resolve({ text: '', attachments: [...attachments] });
            prevBufferRows = 0;
          }
          return;
        }

        // Ctrl+V: paste image from clipboard.
        // The in-flight guard prevents concurrent osascript spawns from rapid
        // key repetition. schedulePaint() is used so that if the user typed
        // during the async probe the repaint reflects the latest buffer state.
        if (key?.ctrl && key?.name === 'v') {
          if (!clipboardInFlight) {
            clipboardInFlight = true;
            readClipboardImage().then((img) => {
              if (img) {
                clipboardFailureMsg = null;
                attachments.push(img);
              } else {
                clipboardFailureMsg = '[clipboard: no image found]';
              }
              schedulePaint();
            }).catch(() => { /* ignore */ }).finally(() => {
              clipboardInFlight = false;
            });
          }
          return;
        }

        if (key?.name === 'escape') {
          if (ac.dropdownOpen) {
            // Pin the dismissal to the current (buffer, cursor) signature so
            // repaint() leaves the menu closed even though detectTrigger still
            // matches (e.g. `/ship ` ends in whitespace and triggers the flag
            // menu unconditionally). Any subsequent edit or cursor move
            // invalidates the signature and re-arms autocomplete.
            ac.suppressedSignature = `${input.cursor}:${input.buffer}`;
            ac.dropdownOpen = false;
            ac.candidates = [];
            repaint();
          }
          return;
        }

        // Ctrl+A: move to start of current logical line (readline emacs-mode).
        if (key?.ctrl && key?.name === 'a') {
          const next = InputCore.moveLineStart(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        // Ctrl+E: move to end of current logical line.
        if (key?.ctrl && key?.name === 'e') {
          const next = InputCore.moveLineEnd(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        // Ctrl+B: char backward (alias for left arrow).
        if (key?.ctrl && key?.name === 'b') {
          const next = InputCore.moveLeft(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        // Ctrl+F: char forward (alias for right arrow).
        if (key?.ctrl && key?.name === 'f') {
          const next = InputCore.moveRight(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        // Alt+B / Option+B: word backward.
        if (key?.meta && key?.name === 'b') {
          const next = InputCore.moveWordBackward(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        // Alt+F / Option+F: word forward.
        if (key?.meta && key?.name === 'f') {
          const next = InputCore.moveWordForward(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        // Ctrl+W: delete word backward (readline backward-kill-word).
        if (key?.ctrl && key?.name === 'w') {
          const next = InputCore.deleteWordBackward(input);
          if (next !== input) { input = next; opts.history?.resetRecall(); repaint(); }
          return;
        }

        // Ctrl+L: clear screen and repaint current draft.
        // External constraint: `cursorTo(0,0)` + eraseDown must precede
        // repaint() — if repaint fires first, its cursorUp math will be
        // wrong relative to the cleared screen.
        if (key?.ctrl && key?.name === 'l') {
          prevBufferRows = 0;
          prevStatusRows = 0;
          stdout.write('\x1b[H\x1b[2J'); // cursor home then erase entire screen
          repaint();
          return;
        }

        // Ctrl+P / ↑: move up one visual row in draft, or recall history.
        // Priority: (1) dropdown → existing selection behavior; (2) cursor can
        // move up in buffer → do that; (3) buffer empty/pristine at top row →
        // recall from history.
        if ((key?.ctrl && key?.name === 'p') || key?.name === 'up') {
          if (ac.dropdownOpen) {
            if (ac.selectedIndex > 0) {
              ac.selectedIndex--;
              if (ac.selectedIndex < ac.viewportStart) ac.viewportStart = ac.selectedIndex;
              repaint();
            }
            return;
          }
          const cols = stdout.columns || 80;
          const result = InputCore.moveUpLine(input, cols, promptVisibleLen);
          if (result.moved) {
            input = result.state;
            opts.history?.resetRecall();
            repaint();
          } else {
            // Cursor is on the first visual row — try history recall.
            if (opts.history) {
              const recalled = opts.history.back(input.buffer);
              if (recalled !== null) {
                input = InputCore.seed(recalled);
                repaint();
              }
            }
          }
          return;
        }

        // Ctrl+N / ↓: move down one visual row in draft, or forward through history.
        if ((key?.ctrl && key?.name === 'n') || key?.name === 'down') {
          if (ac.dropdownOpen) {
            if (ac.selectedIndex < ac.candidates.length - 1) {
              ac.selectedIndex++;
              if (ac.selectedIndex >= ac.viewportStart + maxDropdownRows) {
                ac.viewportStart = ac.selectedIndex - maxDropdownRows + 1;
              }
              repaint();
            }
            return;
          }
          const cols = stdout.columns || 80;
          const result = InputCore.moveDownLine(input, cols, promptVisibleLen);
          if (result.moved) {
            input = result.state;
            opts.history?.resetRecall();
            repaint();
          } else {
            // Cursor is on the last visual row — try history forward.
            if (opts.history) {
              const recalled = opts.history.forward();
              if (recalled !== null) {
                input = InputCore.seed(recalled);
                repaint();
              }
            }
          }
          return;
        }

        if (key?.name === 'left') {
          const next = InputCore.moveLeft(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        if (key?.name === 'right') {
          const next = InputCore.moveRight(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        if (key?.name === 'home') {
          const next = InputCore.moveHome(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        if (key?.name === 'end') {
          const next = InputCore.moveEnd(input);
          if (next !== input) { input = next; repaint(); }
          return;
        }

        // Ctrl+U / Cmd+Delete-when-mapped-to-^U: delete to start of line.
        // macOS Terminal.app intercepts Cmd+Delete and does not forward it to
        // TUI programs by default. iTerm2 and other terminals can be configured
        // to send `\x15` (Ctrl+U) on Cmd+Delete; when they do, this handler
        // fires. Ctrl+U is also a standard readline binding for the same op.
        if (key?.ctrl && key?.name === 'u') {
          const next = InputCore.deleteToLineStart(input);
          if (next !== input) { input = next; opts.history?.resetRecall(); repaint(); }
          return;
        }

        // Ctrl+K: delete to end of line (symmetric counterpart to Ctrl+U).
        if (key?.ctrl && key?.name === 'k') {
          const next = InputCore.deleteToLineEnd(input);
          if (next !== input) { input = next; opts.history?.resetRecall(); repaint(); }
          return;
        }

        // Ctrl+X: discard most-recently-added attachment (no-op if none queued).
        // Binding rationale: unbound in this file; visually associated with
        // cut/remove (Windows cut, Emacs kill-region prefix); avoids EOF risk
        // of Ctrl+D and terminal-suspend risk of Ctrl+Z.
        if (key?.ctrl && key?.name === 'x') {
          if (attachments.length > 0) { attachments.pop(); repaint(); }
          return;
        }

        if (key?.name === 'backspace') {
          // Option+Delete on macOS → meta+backspace: delete previous word.
          if (key?.meta) {
            const next = InputCore.deleteWordBackward(input);
            if (next !== input) { input = next; opts.history?.resetRecall(); repaint(); }
            return;
          }
          const next = InputCore.backspace(input);
          if (next !== input) { input = next; opts.history?.resetRecall(); repaint(); }
          else if (attachments.length > 0) { attachments.pop(); repaint(); }
          return;
        }

        if (key?.name === 'delete') {
          // Option+Fn-Delete on macOS → meta+delete: delete next word.
          if (key?.meta) {
            const next = InputCore.deleteWordForward(input);
            if (next !== input) { input = next; opts.history?.resetRecall(); repaint(); }
            return;
          }
          const next = InputCore.deleteForward(input);
          if (next !== input) { input = next; opts.history?.resetRecall(); repaint(); }
          return;
        }

        if (key?.name === 'return') {
          // shift+enter / alt+enter: insert newline without submitting.
          //
          // Detection order:
          //   1. Node readline keypress: key.shift === true on return in most
          //      terminals (xterm, iTerm2 with default profile, kitty).
          //   2. Kitty keyboard protocol fallback: `\x1b[13;2u` (shift+enter).
          //   3. Alt+enter: key.meta === true on return.
          //
          // Known gap: terminals that do not report shift-state on Enter (e.g.,
          // some tmux configurations, PuTTY, older macOS Terminal.app profiles)
          // will not insert a newline — plain Enter will submit as usual. Users
          // can always use trailing `\` as an escape hatch (preserved below).
          const isShiftEnter =
            key?.shift === true || sequence === '\x1b[13;2u';
          const isAltEnter = key?.meta === true;
          if (isShiftEnter || isAltEnter) {
            input = InputCore.insert(input, '\n');
            opts.history?.resetRecall();
            repaint();
            return;
          }

          // While pasting: add literal newline, do NOT submit
          if (pasting) {
            input = InputCore.insert(input, '\n');
            // Do NOT repaint per-char while pasting; end marker will trigger full repaint
            return;
          }

          // Burst detection: treat rapid 'return' as part of pasted multi-line content
          if (inBurst) {
            input = InputCore.insert(input, '\n');
            schedulePaint();
            return;
          }

          if (ac.dropdownOpen) {
            // Slash commands: one Enter finalizes the choice AND submits.
            // File refs (`@path`): only accept the path — the user is
            // likely mid-sentence and still typing a prompt, so submitting
            // here would send a bare path by mistake. Tab still accepts-
            // only for either kind (see below).
            //
            // COR-2: only submit after a slash completion if applySelection()
            // actually applied a candidate (returns true). If no candidate was
            // selected, applySelection() is a no-op and we must NOT submit the
            // raw partial slash text.
            const kind = ac.trigger?.kind;
            const applied = applySelection();
            if (kind === 'slash' && applied) {
              onSubmit();
            }
          } else if (input.buffer.endsWith('\\')) {
            // Trailing backslash escapes Enter → convert to a real newline.
            input = InputCore.replaceRange(
              input,
              { start: input.buffer.length - 1, end: input.buffer.length },
              '\n',
            );
            repaint();
          } else {
            onSubmit();
          }
          return;
        }

        if ((key?.shift && key?.name === 'tab') || key?.sequence === '\x1b[Z') {
          opts.onShiftTab?.();
          return;
        }

        if (key?.name === 'tab') {
          if (ac.dropdownOpen) {
            applySelection();
          } else {
            // Ghost-accept for mid-sentence skill token (non-compositor path).
            // Mirrors the source (c) logic in getDeterministicGhost (suggest.ts).
            // The compositor path handles its own ghost-accept via applyGhostAccept();
            // this branch covers reader.ts-only surfaces (non-TTY fallback).
            const upToCursor = input.buffer.slice(0, input.cursor);
            const ghostMatch = /\s+\/([A-Za-z][A-Za-z0-9_:-]*)$/.exec(upToCursor);
            if (ghostMatch) {
              const partial = ghostMatch[1]!;
              const slashPartial = '/' + partial;
              const allNames = [
                ...listSlashCommands().map(c => c.name),
                ...aliasEntries().map(e => e.alias),
              ];
              const bestMatch = allNames
                .filter(n => n.startsWith(slashPartial))
                .sort((a, b) => a.localeCompare(b))[0];
              if (bestMatch) {
                const afterCursor = input.buffer.slice(input.cursor);
                const start = input.cursor - slashPartial.length;
                const replacement = bestMatch + (afterCursor.startsWith(' ') ? '' : ' ');
                input = InputCore.replaceRange(input, { start, end: input.cursor }, replacement);
                repaint();
              }
            }
          }
          return;
        }

        // Printable char: prefer `char` (arg 1), fall back to key.sequence
        const printable =
          typeof char === 'string' && char.length === 1 && char >= ' ' && !key?.ctrl && !key?.meta
            ? char
            : typeof key?.sequence === 'string' &&
                key.sequence.length === 1 &&
                key.sequence >= ' ' &&
                !key?.ctrl &&
                !key?.meta
              ? key.sequence
              : null;
        if (printable !== null) {
          input = InputCore.insert(input, printable);
          opts.history?.resetRecall();
          // Suppress repaint while pasting; end marker will trigger full repaint
          if (!pasting) {
            // During bursts, coalesce repaints; otherwise repaint immediately
            if (inBurst) {
              schedulePaint();
            } else {
              repaint();
            }
          }
        }
      };

      // Invariant (resize-handler ordering): two independent constraints
      // documented in this block — (1) zero the row counters before
      // repaint(), and (2) subscribe to ResizeBus before attaching the
      // keypress listener. See sub-sections below.
      //
      // (1) External constraint (resize invalidates row accounting): `repaint()`
      // at lines 115-117 walks `cursorUp(prevStatusRows + prevBufferRows)`
      // to reach the top of the previous render. Those counts were computed
      // at the OLD column width — after a narrow-resize the same buffer now
      // wraps to MORE visual rows, so cursorUp falls short and `eraseDown`
      // strands the orphaned top rows on screen.
      //
      // Zero the counters here so `repaint()` skips the upward walk and
      // starts a fresh render from the current cursor row. Do NOT manually
      // emit `\r` + eraseDown before delegating — `repaint()` already does
      // that at lines 121-122, and a double-emit would race StatusLine's
      // 150ms-debounced DECSTBM write that fires on the same ResizeBus tick.
      //
      // NOTE: This path is dormant in the normal TTY REPL (the persistent
      // TerminalCompositor's onSubmit path takes over — see
      // `input-surface.ts:309`). The fix matters for non-TTY-fallback
      // surfaces (piped input, tests) that route through this reader.
      //
      // (2) Subscription-before-keypress ordering: resizeUnsub must
      // be assigned BEFORE the keypress listener is attached. A synchronous
      // keypress between the two would otherwise reach cleanup() with
      // resizeUnsub === null and leave the ResizeBus subscriber attached
      // after the promise settles.
      //
      // Route through ResizeBus instead of `stdout.on('resize')` directly:
      // (1) coalesces rapid window-drag events into one 150ms-debounced
      // repaint (was firing per-event before), (2) shares the single stdout
      // listener with TerminalCompositor + StatusLine instead of fan-out
      // racing them on every resize event.
      resizeUnsub = ResizeBus.subscribe(() => {
        prevBufferRows = 0;
        prevStatusRows = 0;
        rowsBelow = 0;
        repaint();
      });
      stdin.on('keypress', handleKeypress);
    });
  } finally {
    // Teardown-before-setup convention: restore extraRows reservation BEFORE
    // raw-mode restore so any throw in setExtraRows still hits rawMode.restore.
    opts.statusLine?.setExtraRows(priorExtraRows);
    // Idempotent — also called from any abort path inside the keypress
    // handler so the terminal is restored exactly once.
    rawMode.restore();
    // Release the stdin claim after restoring raw mode so the TTY is in a
    // consistent state before the next acquirer can proceed.
    stdinClaim?.release();
  }
}
