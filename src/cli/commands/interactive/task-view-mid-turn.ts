/**
 * Mid-turn task view — view a subagent's live output while the parent
 * turn is still streaming.
 *
 * Triggered by Tab during streaming mode when a task-view handler is
 * wired. Uses the compositor's `suspendInput()` / `resumeInput()` seam
 * (the same mechanism the $EDITOR handoff uses) to temporarily hand the
 * terminal to a simple output-tail loop. The parent turn's streaming
 * continues on the event loop; the compositor accumulates overlay updates
 * internally but does not repaint until `resumeInput()` restores it.
 *
 * Press Esc to return to the normal streaming view.
 *
 * Invariant: this module never calls `enterPickerMode`. The picker
 * abstraction is scoped to short menus, not unbounded streaming output.
 *
 * @module cli/commands/interactive/task-view-mid-turn
 */

import { palette } from '../../palette.js';
import { formatOutputEvent } from '../../output-event-format.js';
import {
  renderTaskViewHeader,
  buildTaskFooterLine,
} from './task-view-mode.js';
import { getTasksManager } from '../../slash/commands/tasks.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { truncateDisplayWidth, suffixDisplayWidth, previousGraphemeIndex } from '../../display.js';
import { registerCleanup } from '../../../utils/cleanupRegistry.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import type { OutputEvent } from '../../../agent/types/session-types.js';
import type { TurnHandles } from './shared.js';

// Item 4: cap for input buffer to prevent unbounded accumulation.
const MAX_INPUT_BYTES = 8192;

// The prompt prefix ("> ") occupies 2 visible columns.
const PREFIX_WIDTH = 2;

// DEC private mode sequences for the alternate screen buffer.
// Teardown constant is declared before setup constant (ordered-sequence rule).
//
// Invariant: LEAVE_ALT_SCREEN must be written to stdout BEFORE every
// compositor.resumeInput() call, or the compositor repaints into the alt
// buffer and the main screen is never restored.
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const ENTER_ALT_SCREEN = '\x1b[?1049h';

// FIX-1: Reentrancy guard — prevents double-Tab from launching two concurrent
// task views, each installing their own stdin listener.
let midTurnViewActive = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MidTurnTaskViewOptions {
  /** The SubagentManager to look up active handles. */
  manager: SubagentManager;
  /** The armed TerminalCompositor (for suspend/resume and stdout access). */
  compositor: TerminalCompositor;
}

// ---------------------------------------------------------------------------
// Alt-screen lifecycle with signal-safe teardown
// ---------------------------------------------------------------------------

/**
 * Enter the alternate screen buffer and register two complementary teardown
 * guards so that LEAVE_ALT_SCREEN is always written on signal- or exit-driven
 * teardown, not only on the normal Esc path.
 *
 * Returns `{ disarmCleanup, leaveAltScreen }`.  The normal exit path MUST call
 * `disarmCleanup()` and then `leaveAltScreen()` — the same `fired` flag is
 * shared by all three paths so LEAVE_ALT_SCREEN is written at most once no
 * matter which path executes first.
 *
 * Invariant (cleanup ordering):
 *   - The cleanup-registry function runs during runCleanupFunctions() called
 *     by the signal handler (SIGTERM/SIGHUP after grace period) and by the
 *     REPL's rl.on('close') path.  It writes LEAVE_ALT_SCREEN directly to
 *     the compositor's stdout without touching resumeInput (the compositor is
 *     already tearing down on that path).
 *   - The process.on('exit') fallback fires synchronously on process.exit()
 *     and catches any path that bypasses the cleanup registry (e.g. SIGINT
 *     double-press in the interactive cleanup or an unhandled rejection).
 *   - Both guards and the happy-path leaveAltScreen share the `fired` flag,
 *     so the first writer wins and all subsequent calls are no-ops.
 *
 * Invariant (leave ordering inside leaveAltScreen):
 *   1. stdout.write(LEAVE_ALT_SCREEN)  — escape the alt buffer FIRST
 *   2. compositor.resumeInput()        — compositor may now repaint
 *   3. compositor.repaint()            — force immediate redraw
 *
 * Teardown helper declared before launchMidTurnTaskView (ordered-sequence rule).
 */
function enterAltScreen(compositor: TerminalCompositor): {
  disarmCleanup: () => void;
  leaveAltScreen: () => void;
} {
  compositor.stdout.write(ENTER_ALT_SCREEN + '\x1b[2J\x1b[H');

  // Invariant: `fired` is the single source of truth for whether LEAVE_ALT_SCREEN
  // has been emitted.  All three paths (cleanup registry, process.exit guard, and
  // the normal leaveAltScreen call) check and set this flag atomically.  The first
  // path to run wins; the others are no-ops.  This makes writeLeave genuinely
  // idempotent across all teardown routes, including the SIGTERM path described
  // in interactive.cleanup.ts: runCleanupFunctions() fires the registry function,
  // then process.exit(0) fires the still-registered 'exit' listener — without this
  // flag the sequence writes LEAVE_ALT_SCREEN twice and corrupts the main screen.
  let fired = false;
  const writeLeave = (): void => {
    if (fired) return;
    fired = true;
    compositor.stdout.write(LEAVE_ALT_SCREEN);
  };

  // One-shot process.on('exit') fallback: fires synchronously on any
  // process.exit() call that bypasses the cleanup registry (e.g. SIGINT
  // double-press timeout, unhandled rejection).  Removed on normal leave so
  // no listener leaks across repeated opens.
  process.on('exit', writeLeave);

  // Cleanup-registry registration: runs during runCleanupFunctions() called
  // by the signal handler grace-period timeout and by rl.on('close').
  const unregisterCleanup = registerCleanup(async (): Promise<void> => {
    writeLeave();
  });

  // disarmCleanup: removes both guards before the happy-path leaveAltScreen
  // writes the sequence, so the guards cannot fire a redundant write afterward.
  const disarmCleanup = (): void => {
    unregisterCleanup();
    process.removeListener('exit', writeLeave);
  };

  // leaveAltScreen: the normal exit path.  Uses the shared `fired` flag so a
  // guard that races the normal path (e.g. a process.exit() arriving between
  // disarmCleanup and leaveAltScreen) cannot produce a second write.
  //
  // Invariant (ordering): stdout.write(LEAVE_ALT_SCREEN) BEFORE resumeInput;
  // otherwise the compositor repaints into the alt buffer on resumeInput.
  const leaveAltScreen = (): void => {
    writeLeave();
    compositor.resumeInput();
    compositor.repaint();
  };

  return { disarmCleanup, leaveAltScreen };
}

/**
 * Consume the subagent's output stream and write each event to the alt-screen.
 *
 * Contract: content chunks are streaming token deltas (a few words each).
 * Writing each chunk as its own line produces the one-word-per-line wrapping
 * bug. Instead, content is buffered into the current line and flushed only when:
 *   (a) the chunk contains a newline (model intended a line break), or
 *   (b) a non-content event arrives (tool_use_detail, error, message).
 * stream_retry discards the in-progress buffer WITHOUT flushing so stale
 * content is never committed to the terminal. Swallows any iterator error so
 * the caller's finally block always runs (Esc / abort / stream-end are all
 * handled the same way by the caller).
 */
async function tailOutputStream(params: {
  stream: AsyncIterable<OutputEvent>;
  signal: AbortSignal;
  stdout: NodeJS.WriteStream;
  clamp: (s: string) => string;
  renderPrompt: () => void;
}): Promise<void> {
  const { stream, signal, stdout, clamp, renderPrompt } = params;
  let lineBuf = '';

  // Invariant: lineBuf never contains \n -- segments are split before accumulation.
  // `force` emits a blank line even when lineBuf is empty -- used for model-
  // intended newlines so consecutive \n produce visible paragraph breaks.
  const flushLineBuf = (force = false): void => {
    if (!lineBuf && !force) return;
    stdout.write(`\r\x1b[K${lineBuf}\n`);
    lineBuf = '';
    renderPrompt();
  };

  try {
    for await (const event of stream) {
      if (signal.aborted) break;

      if (event.type === 'chunk' && event.chunk.type === 'content') {
        const raw = stripEscapeSequences(event.chunk.content);
        const segments = raw.split('\n');
        for (let i = 0; i < segments.length; i++) {
          lineBuf += segments[i]!;
          // Flush on every embedded newline (all segments except the last).
          // force=true preserves blank lines from consecutive \n.
          if (i < segments.length - 1) flushLineBuf(true);
        }
        // Live preview: show the in-progress line on the prompt row so the
        // user sees text accumulate in real time (overwritten by renderPrompt
        // or the next flushLineBuf). \r\x1b[K clears the prompt line first.
        if (lineBuf) {
          stdout.write(`\r\x1b[K${clamp(lineBuf)}`);
        }
        continue;
      }

      // stream_retry: the model is re-streaming from scratch — discard the
      // stale in-progress buffer WITHOUT flushing so the old content is not
      // committed to the terminal. Matches the pattern in turn-handler.ts:455.
      if (event.type === 'stream_retry') {
        lineBuf = '';
        stdout.write('\r\x1b[K');
        renderPrompt();
        continue;
      }

      // Non-content event: flush any buffered content first, then emit the
      // event on its own line (tool badges, errors are discrete lines).
      flushLineBuf();
      const text = formatOutputEvent(event);
      if (text !== null) {
        stdout.write(`\r\x1b[K${clamp(text)}\n`);
        renderPrompt();
      }
    }
  } catch {
    // Abort or stream error — exit cleanly.
  } finally {
    // Flush any trailing content that didn't end with a newline.
    flushLineBuf();
  }
}

/**
 * Launch a mid-turn task view for the most recently dispatched running
 * subagent. The compositor's input is suspended (no keypresses reach the
 * compositor's dispatch chain) and a raw stdin listener handles Esc to
 * exit. The parent turn's streaming continues in the background.
 *
 * Returns a Promise that resolves to true when the view was shown, or
 * false when no running subagents were found (so the caller can fall
 * through to ghost-accept).
 */
export async function launchMidTurnTaskView(
  opts: MidTurnTaskViewOptions,
): Promise<boolean> {
  const { manager, compositor } = opts;

  // Find the most recently dispatched running subagent.
  const listed = manager.list();
  const runningIds = listed
    .filter((h) => h.status === 'running' || h.status === 'idle')
    .map((h) => h.id);
  // Item 6: return false so caller can fall through to ghost-accept.
  if (runningIds.length === 0) return false;

  // Pick the most recent (last in the list) and resolve the full handle.
  const id = runningIds[runningIds.length - 1]!;
  const handle = manager.get(id);
  if (!handle) return false;
  const agentType = (handle as unknown as { _agentType?: string })?._agentType;

  const stdout = compositor.stdout;
  // Contract: clamp any user-visible content line to terminal width.
  // `truncateDisplayWidth` is ANSI-aware — it preserves color codes while
  // clamping display width. Cursor-movement ANSI sequences (CSI codes) are
  // NOT passed through this helper; they bypass clamp() entirely.
  //
  // Invariant: multiline strings must be split on \n and clamped per-line.
  // `string-width` treats \n as zero-width, so a multiline string's total
  // display width is the SUM of its lines — truncateDisplayWidth would cut
  // mid-string and drop later lines instead of clamping each independently.
  const width = stdout.columns || 80;
  const clamp = (s: string): string =>
    s.includes('\n')
      ? s.split('\n').map(line => truncateDisplayWidth(line, width)).join('\n')
      : truncateDisplayWidth(s, width);

  // FIX-1: Mark the view as active AFTER all early-return guards so the
  // flag is never stuck true when no subagent is found or handle is null.
  midTurnViewActive = true;

  // Suspend the compositor's input handling so we own stdin directly.
  // The compositor remains armed; setOverlay() calls from the streaming
  // turn keep accumulating internally. When we call resumeInput() the
  // compositor repaints with the current (accumulated) overlay state.
  compositor.suspendInput();
  // Item 1: re-enable raw mode after suspending so keystrokes arrive per-byte.
  try { process.stdin.setRawMode?.(true); } catch { /* non-TTY */ }

  // Enter the alternate screen buffer (writes ENTER_ALT_SCREEN + clear/home)
  // and register two teardown guards so LEAVE_ALT_SCREEN is written even on
  // signal- or exit-driven teardown.  disarmCleanup() MUST be called on every
  // normal exit path before leaveAltScreen() to prevent a double-leave.
  const { disarmCleanup, leaveAltScreen } = enterAltScreen(compositor);
  const status = handle.status ?? 'running';
  stdout.write(clamp(renderTaskViewHeader(id, status, agentType)) + '\n\n');

  // Render in-memory history if available.
  if (typeof handle.session.getHistory === 'function') {
    const history = handle.session.getHistory();
    for (const msg of history) {
      const role = msg.role === 'user' ? palette.bold('user') : palette.bold('assistant');
      stdout.write(clamp(`${role}:`) + '\n');
      // Item 3: extract text from ContentBlock arrays; fall back to JSON for
      // other shapes. Item 2: sanitize before writing to stdout.
      const raw = msg.content;
      const text = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? (raw as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text!)
              .join('\n')
          : JSON.stringify(raw);
      const safe = stripEscapeSequences(text);
      for (const l of safe.split('\n')) stdout.write(clamp(`  ${l}`) + '\n');
      stdout.write('\n');
    }
  }

  const isRunning = status === 'running' || status === 'idle';
  stdout.write(clamp(buildTaskFooterLine(isRunning)) + '\n');

  if (!isRunning) {
    // Already completed — show briefly then return.
    // Item 1: restore cooked mode before resuming compositor.
    try { process.stdin.setRawMode?.(false); } catch { /* non-TTY */ }
    midTurnViewActive = false;
    // Disarm before leaveAltScreen so the cleanup guards do not emit a
    // redundant LEAVE_ALT_SCREEN after the normal leave writes it.
    disarmCleanup();
    leaveAltScreen();
    return true;
  }

  // Tail live output until Esc or stream ends. The user can also type
  // a message and press Enter to send it to the subagent as a new turn.
  const abort = new AbortController();
  const { signal } = abort;
  let inputBuf = '';

  const renderPrompt = (): void => {
    // Suffix-viewport: always show the rightmost portion of the input so the
    // user can see what they're typing even when inputBuf exceeds the terminal
    // width. suffixDisplayWidth prepends an ellipsis ("…") to signal that
    // content is hidden on the left; for short inputs it returns the buffer
    // as-is (no ellipsis). The prefix ">" and the visible portion together
    // always fit within `width` display columns.
    const available = Math.max(0, width - PREFIX_WIDTH);
    const visibleBuf = suffixDisplayWidth(inputBuf, available);
    stdout.write(`\r\x1b[K${palette.dim('> ')}${visibleBuf}`);
  };

  // Raw stdin listener: Esc exits, Enter sends, printable chars accumulate.
  const onData = (data: Buffer): void => {
    const str = data.toString();
    if (str === '\x1b') {
      abort.abort();
      return;
    }
    if (str === '\r' || str === '\n') {
      const msg = inputBuf.trim();
      if (msg) {
        handle.sendMessage(msg);
        // FIX-3: Sanitize echo to prevent ANSI injection from paste content.
        stdout.write(`\r\x1b[K${clamp(palette.user('you') + ': ' + stripEscapeSequences(msg))}\n`);
        inputBuf = '';
        renderPrompt();
      }
      return;
    }
    // Backspace / Delete.
    if (str === '\x7f' || str === '\b') {
      if (inputBuf.length > 0) {
        inputBuf = inputBuf.slice(0, previousGraphemeIndex(inputBuf, inputBuf.length));
        renderPrompt();
      }
      return;
    }
    // Ignore control characters and escape sequences.
    if (str.length === 1 && str.charCodeAt(0) < 32) return;
    // Item 5: catch ALL escape sequences (CSI, OSC, SS3, DCS), not just CSI.
    if (str.startsWith('\x1b')) return;
    // Item 4: cap the input buffer to avoid unbounded growth.
    if (Buffer.byteLength(inputBuf + str, 'utf8') > MAX_INPUT_BYTES) return;
    inputBuf += stripEscapeSequences(str);
    renderPrompt();
  };
  process.stdin.on('data', onData);

  stdout.write(clamp(palette.dim('  Type a message + Enter to send, Esc to return')) + '\n');
  renderPrompt();

  try {
    await tailOutputStream({
      stream: handle.session.getOutputStream() as AsyncIterable<OutputEvent>,
      signal,
      stdout,
      clamp,
      renderPrompt,
    });

    if (!signal.aborted) {
      // Invariant: remove the onData listener BEFORE waitForEsc() so keystrokes
      // typed during the 'Press Esc to return.' pause do not mutate inputBuf or
      // trigger renderPrompt.  waitForEsc() installs its own independent listener
      // that only reacts to Esc.  The finally below keeps a harmless idempotent
      // backstop for any path that bypasses this branch.
      process.stdin.removeListener('data', onData);
      stdout.write('\r\x1b[K\n' + clamp(palette.dim('  Subagent completed. Press Esc to return.')) + '\n');
      await waitForEsc();
    }
  } finally {
    // Idempotent backstop: removeListener is a no-op when the listener is
    // already gone (removed above on the completed path or never added).
    process.stdin.removeListener('data', onData);
    // Item 1: restore cooked mode before handing terminal back to compositor.
    try { process.stdin.setRawMode?.(false); } catch { /* non-TTY */ }
    // FIX-1: Clear the reentrancy guard so a subsequent Tab is accepted.
    midTurnViewActive = false;
    // Disarm before leaveAltScreen so the cleanup guards do not emit a
    // redundant LEAVE_ALT_SCREEN after the normal leave writes it.
    disarmCleanup();
    leaveAltScreen();
  }

  return true;
}

/**
 * Block until the user presses Esc, the stdin closes, or 30 s elapses.
 * Item 9: timeout + close-handler prevents the function from leaking
 * indefinitely when stdin is closed or the process exits.
 */
function waitForEsc(): Promise<void> {
  return new Promise<void>((resolve) => {
    // Item 1: ensure raw mode is active so the Esc byte arrives immediately.
    try { process.stdin.setRawMode?.(true); } catch { /* non-TTY */ }
    const cleanup = (): void => {
      process.stdin.removeListener('data', onEsc);
      process.stdin.removeListener('close', cleanup);
      clearTimeout(timer);
      // Item 1: restore cooked mode when leaving.
      try { process.stdin.setRawMode?.(false); } catch { /* non-TTY */ }
      resolve();
    };
    const onEsc = (data: Buffer): void => {
      if (data.toString() === '\x1b') cleanup();
    };
    // Item 9: 30 s safety timeout so this never hangs indefinitely.
    const timer = setTimeout(cleanup, 30_000);
    process.stdin.on('data', onEsc);
    // Item 9: resolve if stdin closes (e.g. pipe / daemon context).
    process.stdin.on('close', cleanup);
  });
}

// ---------------------------------------------------------------------------
// Turn-handler factory
// ---------------------------------------------------------------------------

/**
 * Build the per-turn Tab handler closure from TurnHandles. Returns null
 * when the compositor or manager is unavailable (non-TTY, daemon).
 * Called from turn-handler.ts to keep the wiring boilerplate out of the
 * already-baselined turn handler.
 *
 * Item 6: the returned closure returns a boolean — true when the task view
 * was launched (running subagents exist), false otherwise — so the Tab
 * dispatch can fall through to ghost-accept when no tasks are running.
 */
export function createTaskViewHandler(
  h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'>,
): (() => boolean) | null {
  const compositor = h.getCompositor?.();
  if (!compositor) return null;
  return () => {
    // FIX-1: Suppress double-Tab — if a view is already active, fall through
    // to ghost-accept rather than launching a second concurrent instance.
    if (midTurnViewActive) return false;
    const manager = getTasksManager();
    if (!manager) return false;
    // Synchronous check: are there running subagents?
    const hasRunning = manager.list().some(
      (handle) => handle.status === 'running' || handle.status === 'idle',
    );
    if (!hasRunning) return false;
    void launchMidTurnTaskView({ manager, compositor });
    return true;
  };
}
