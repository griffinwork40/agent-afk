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
 *
 * Implementation is decomposed into named module-level helpers:
 *   - repaint / schedulePaint  ({@link ./reader.repaint.ts})
 *   - applySelection           ({@link ./reader.selection.ts})
 *   - handleKeypress           ({@link ./reader.keypress.ts})
 *   - ReaderState bag          ({@link ./reader.state.ts})
 */

import * as ansiEscapes from 'ansi-escapes';
import { emitKeypressEventsImmediateEscape } from './emit-keypress.js';
import stringWidth from 'string-width';
import { createSlashRegistryView } from '../slash/registry.js';
import { stripAnsi } from '../display.js';
import { acquireStdinClaim } from './stdin-claim.js';
import { InputCore } from '../input-core.js';
import { colorizeInputBuffer } from '../input-highlight.js';
import { describeAttachmentSummary } from './attachments.js';
import { formatSubmittedEcho } from './echo.js';
import { enterRawMode } from './raw-mode.js';
import { createAutocompleteState } from './autocomplete-state.js';
import { ResizeBus } from '../terminal-size.js';
import { repaint, schedulePaint } from './reader.repaint.js';
import { applySelection } from './reader.selection.js';
import { handleKeypress } from './reader.keypress.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx } from './reader.repaint.js';
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
  const rawMode = compositorArmed
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

  let keypressListener: ((char: string | undefined, key: KeyInfo) => void) | null = null;
  // ResizeBus.subscribe() returns an unsub fn; call it in cleanup() to detach
  // the subscriber without round-tripping through the listener reference
  // (avoids the "remove the wrong fn" footgun of the former stdout.on path).
  let resizeUnsub: (() => void) | null = null;

  try {
    opts.statusLine?.setExtraRows(priorExtraRows + 1);
    return await new Promise<ReadWithAutocompleteResult>((resolve, reject) => {
      // Use injected autocomplete state when provided (unified InputSurface);
      // otherwise fall back to a fresh local state (backward-compatible).
      // reset() is called here so any stale state from a prior agent-turn
      // (e.g. open dropdown that was never dismissed) does not leak in.
      const ac = opts.autocompleteState ?? createAutocompleteState();
      ac.reset();

      const PASTE_WINDOW_MS = 8;

      // All mutable per-read locals, passed by reference to every helper.
      const st: ReaderState = {
        input: InputCore.seed(opts.initialBuffer ?? ''),
        ac,
        rowsBelow: 0,
        pasting: false,
        clipboardInFlight: false,
        pasteStartBufferLen: 0,
        prevBufferRows: 0,
        prevStatusRows: 0,
        clipboardFailureMsg: null,
        attachments: [],
        maxDropdownRows: 6,
        lastKeypressAt: 0,
        repaintPending: false,
        settled: false,
      };

      // Adapter for the slash highlighter. Delegates membership to the
      // registry's alias-aware `has()` (via `createSlashRegistryView`) so
      // aliased commands (e.g. `/quit`) colorize brand, not dim — and so the
      // per-keystroke memo still invalidates on any mid-session hot-swap.
      const repaintCtx: RepaintCtx = {
        stdout,
        promptText,
        promptVisibleLen,
        slashRegistryView: createSlashRegistryView(),
        historyGetEntries: opts.history?.getEntries?.bind(opts.history),
      };

      const cleanup = () => {
        st.settled = true; // COR-1: prevent queued setImmediate repaints after settle.
        if (keypressListener) stdin.removeListener('keypress', keypressListener);
        if (resizeUnsub) resizeUnsub();
        keypressListener = null;
        resizeUnsub = null;
      };

      const onSubmit = () => {
        // Clear dropdown (if any) and leave the submitted input line as the last
        // visible row, with cursor on the next line for the caller's output.
        if (st.prevStatusRows > 0 || st.prevBufferRows > 0) {
          stdout.write(ansiEscapes.cursorUp(st.prevStatusRows + st.prevBufferRows));
        }
        // Erase everything below the cursor so any prior multi-line edit
        // state or dropdown chrome is cleared before the echo is rewritten.
        stdout.write('\r');
        stdout.write(ansiEscapes.eraseDown);
        st.rowsBelow = 0;
        // eraseDown above wipes the in-input `renderStatusLine` indicator, so
        // any attachment acknowledgment must be re-emitted as part of the
        // post-submit echo or the user loses all visual confirmation that an
        // image rode along with the turn.
        const echo = formatSubmittedEcho({
          buffer: colorizeInputBuffer(st.input.buffer, repaintCtx.slashRegistryView),
          promptText,
          isTTY: Boolean(stdout.isTTY),
          attachmentSummary: describeAttachmentSummary(st.attachments),
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
        resolve({ text: st.input.buffer, attachments: [...st.attachments] });
        st.prevBufferRows = 0;
      };

      const onAbort = (err: Error) => {
        if (st.prevBufferRows > 0) {
          stdout.write(ansiEscapes.cursorUp(st.prevBufferRows));
        }
        if (st.rowsBelow > 0) {
          stdout.write(ansiEscapes.eraseDown);
          st.rowsBelow = 0;
        }
        stdout.write('\n');
        cleanup();
        reject(err);
        st.prevBufferRows = 0;
      };

      // Ctrl+D on an empty buffer: resolve with empty text (not rejection).
      const onEof = () => {
        cleanup();
        resolve({ text: '', attachments: [...st.attachments] });
        st.prevBufferRows = 0;
      };

      keypressListener = (char: string | undefined, key: KeyInfo) => {
        handleKeypress(char, key, st, {
          opts,
          stdout,
          repaintCtx,
          callbacks: { onSubmit, onAbort, onEof },
          pasteWindowMs: PASTE_WINDOW_MS,
        }, repaint, schedulePaint, applySelection);
      };

      // Initial render: prompt + (empty) buffer on the current line.
      repaint(st, repaintCtx);

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
        st.prevBufferRows = 0;
        st.prevStatusRows = 0;
        st.rowsBelow = 0;
        repaint(st, repaintCtx);
      });
      stdin.on('keypress', keypressListener);
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
