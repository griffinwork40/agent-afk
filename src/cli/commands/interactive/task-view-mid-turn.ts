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
import type { SubagentManager } from '../../../agent/subagent.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import type { OutputEvent } from '../../../agent/types/session-types.js';
import type { TurnHandles } from './shared.js';

// Item 4: cap for input buffer to prevent unbounded accumulation.
const MAX_INPUT_BYTES = 8192;

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

  // Clear screen and render the task view header.
  stdout.write('\x1b[2J\x1b[H'); // clear screen + cursor home
  const status = handle.status ?? 'running';
  stdout.write(renderTaskViewHeader(id, status, agentType) + '\n\n');

  // Render in-memory history if available.
  if (typeof handle.session.getHistory === 'function') {
    const history = handle.session.getHistory();
    for (const msg of history) {
      const role = msg.role === 'user' ? palette.bold('user') : palette.bold('assistant');
      stdout.write(`${role}:\n`);
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
      for (const l of safe.split('\n')) stdout.write(`  ${l}\n`);
      stdout.write('\n');
    }
  }

  const isRunning = status === 'running' || status === 'idle';
  stdout.write(buildTaskFooterLine(isRunning) + '\n');

  if (!isRunning) {
    // Already completed — show briefly then return.
    // Item 1: restore cooked mode before resuming compositor.
    try { process.stdin.setRawMode?.(false); } catch { /* non-TTY */ }
    midTurnViewActive = false;
    compositor.resumeInput();
    compositor.repaint();
    return true;
  }

  // Tail live output until Esc or stream ends. The user can also type
  // a message and press Enter to send it to the subagent as a new turn.
  const abort = new AbortController();
  const { signal } = abort;
  let inputBuf = '';

  const renderPrompt = (): void => {
    // Overwrite the current line with the input prompt.
    stdout.write(`\r\x1b[K${palette.dim('> ')}${inputBuf}`);
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
        stdout.write(`\r\x1b[K${palette.user('you')}: ${stripEscapeSequences(msg)}\n`);
        inputBuf = '';
        renderPrompt();
      }
      return;
    }
    // Backspace / Delete.
    if (str === '\x7f' || str === '\b') {
      if (inputBuf.length > 0) {
        inputBuf = inputBuf.slice(0, -1);
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
    inputBuf += str;
    renderPrompt();
  };
  process.stdin.on('data', onData);

  stdout.write(palette.dim('  Type a message + Enter to send, Esc to return\n'));
  renderPrompt();

  try {
    for await (const event of handle.session.getOutputStream() as AsyncIterable<OutputEvent>) {
      if (signal.aborted) break;
      const text = formatOutputEvent(event);
      if (text !== null) {
        // Clear the input prompt line, write output, re-render prompt.
        stdout.write(`\r\x1b[K${text}\n`);
        renderPrompt();
      }
    }
  } catch {
    // Abort or stream error — exit cleanly.
  } finally {
    process.stdin.removeListener('data', onData);

    if (!signal.aborted) {
      stdout.write('\r\x1b[K\n' + palette.dim('  Subagent completed. Press Esc to return.') + '\n');
      await waitForEsc();
    }

    // Item 1: restore cooked mode before handing terminal back to compositor.
    try { process.stdin.setRawMode?.(false); } catch { /* non-TTY */ }
    // FIX-1: Clear the reentrancy guard so a subsequent Tab is accepted.
    midTurnViewActive = false;
    compositor.resumeInput();
    compositor.repaint();
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
