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
import type { SubagentManager } from '../../../agent/subagent.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import type { OutputEvent } from '../../../agent/types/session-types.js';
import type { TurnHandles } from './shared.js';

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
 * Returns a Promise that resolves when the user presses Esc or the
 * subagent finishes.
 */
export async function launchMidTurnTaskView(
  opts: MidTurnTaskViewOptions,
): Promise<void> {
  const { manager, compositor } = opts;

  // Find the most recently dispatched running subagent.
  const listed = manager.list();
  const runningIds = listed
    .filter((h) => h.status === 'running' || h.status === 'idle')
    .map((h) => h.id);
  if (runningIds.length === 0) return;

  // Pick the most recent (last in the list) and resolve the full handle.
  const id = runningIds[runningIds.length - 1]!;
  const handle = manager.get(id);
  if (!handle) return;
  const agentType = (handle as unknown as { _agentType?: string })?._agentType;

  const stdout = compositor.stdout;

  // Suspend the compositor's input handling so we own stdin directly.
  // The compositor remains armed; setOverlay() calls from the streaming
  // turn keep accumulating internally. When we call resumeInput() the
  // compositor repaints with the current (accumulated) overlay state.
  compositor.suspendInput();

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
      const raw = msg.content;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      for (const l of text.split('\n')) stdout.write(`  ${l}\n`);
      stdout.write('\n');
    }
  }

  const isRunning = status === 'running' || status === 'idle';
  stdout.write(buildTaskFooterLine(isRunning) + '\n');

  if (!isRunning) {
    // Already completed — show briefly then return.
    compositor.resumeInput();
    compositor.repaint();
    return;
  }

  // Tail live output until Esc or stream ends.
  const abort = new AbortController();
  const { signal } = abort;

  // Raw stdin listener for Esc. The compositor is suspended so its
  // keypress listener is detached — we are the sole stdin consumer.
  const onData = (data: Buffer): void => {
    const str = data.toString();
    // Esc = \x1b alone (not part of a longer escape sequence).
    if (str === '\x1b') {
      abort.abort();
    }
  };
  process.stdin.on('data', onData);

  try {
    for await (const event of handle.session.getOutputStream() as AsyncIterable<OutputEvent>) {
      if (signal.aborted) break;
      const text = formatOutputEvent(event);
      if (text !== null) {
        stdout.write(text + '\n');
      }
    }
  } catch {
    // Abort or stream error — exit cleanly.
  } finally {
    process.stdin.removeListener('data', onData);

    // Show completion or return notice.
    if (!signal.aborted) {
      stdout.write('\n' + palette.dim('  Subagent completed. Press Esc to return.') + '\n');
      // Wait for Esc after natural completion.
      await new Promise<void>((resolve) => {
        const onEsc = (data: Buffer): void => {
          if (data.toString() === '\x1b') {
            process.stdin.removeListener('data', onEsc);
            resolve();
          }
        };
        process.stdin.on('data', onEsc);
      });
    }

    // Restore the compositor. It repaints with the current overlay state
    // (all streaming updates that arrived while we were viewing have
    // accumulated internally).
    compositor.resumeInput();
    compositor.repaint();
  }
}

// ---------------------------------------------------------------------------
// Turn-handler factory
// ---------------------------------------------------------------------------

/**
 * Build the per-turn Tab handler closure from TurnHandles. Returns null
 * when the compositor or manager is unavailable (non-TTY, daemon).
 * Called from turn-handler.ts to keep the wiring boilerplate out of the
 * already-baselined turn handler.
 */
export function createTaskViewHandler(
  h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'>,
): (() => void) | null {
  const compositor = h.getCompositor?.();
  if (!compositor) return null;
  return () => {
    const manager = getTasksManager();
    if (!manager) return;
    void launchMidTurnTaskView({ manager, compositor });
  };
}
