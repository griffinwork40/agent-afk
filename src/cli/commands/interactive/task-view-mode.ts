/**
 * Live task-view mode for the REPL.
 *
 * Entered when `/tasks:view <id>` is invoked. While active, the REPL
 * shows the subagent's conversation history and tails live output from a
 * running subagent in real-time. Pressing Esc returns to the normal prompt.
 *
 * Architecture:
 *   - `enterTaskViewMode` — called by `/tasks:view`. Renders history,
 *     starts live tailing if the subagent is still running, and wires Esc
 *     to exit via `ctx.setSoftStopHandler`.
 *   - `renderTaskViewHeader` — builds the status header for a given task.
 *   - `buildTaskFooterLine` — footer line shown under the conversation.
 *   - `exitTaskViewMode` — clears `ctx.viewingTaskId`, restores the status
 *     line, and emits a return banner.
 *
 * @module cli/commands/interactive/task-view-mode
 */

import { palette } from '../../palette.js';
import { formatOutputEvent } from '../../output-event-format.js';
import { renderMessagesView } from './task-view.js';
import { SubagentLogReader } from '../../../agent/subagent/log.js';
import type { SubagentManager } from '../../../agent/subagent.js';
import type { SlashContext } from '../../slash/types.js';
import type { InteractiveCtx } from './shared.js';
import type { OutputEvent } from '../../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Narrow seam passed from the slash context into the view mode entry point. */
export interface TaskViewEntry {
  /** Resolved subagent ID to view. */
  id: string;
  /** Subagent manager to look up running handles. */
  manager: SubagentManager;
  /** Session label for disk-log fallback. */
  sessionLabel: string;
  /** SlashContext for ui/out/setSoftStopHandler access. */
  ctx: SlashContext;
  /**
   * InteractiveCtx used to set/clear `viewingTaskId`. Optional — absent in
   * pure-slash test environments where InteractiveCtx is not wired.
   */
  ictx?: InteractiveCtx;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOOTER_RUNNING  = palette.dim('  Task running… (press Esc to return)');
const FOOTER_COMPLETE = palette.dim('  Task complete (press Esc to return)');
const FOOTER_RETURN   = palette.dim('  Returned to main conversation.');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Format the status badge for a given subagent status string. */
function statusBadge(status: string): string {
  if (status === 'succeeded' || status === 'completed') return palette.success(status);
  if (status === 'failed')    return palette.error(status);
  if (status === 'running')   return palette.info(status);
  if (status === 'cancelled') return palette.dim(status);
  return palette.dim(status);
}

/** Separator line sized to terminal width (max 100). */
function sep(width = 80): string {
  const w = Math.min(width, 100);
  return palette.dim('─'.repeat(w));
}

/** Render the header for a task view panel. */
export function renderTaskViewHeader(
  id: string,
  status: string,
  agentType?: string,
): string {
  const parts: string[] = [
    palette.bold(`Subagent: ${id.slice(0, 20)}`),
    ...(agentType ? [palette.dim(`type: ${agentType}`)] : []),
    `status: ${statusBadge(status)}`,
  ];
  return [sep(), parts.join('  '), sep()].join('\n');
}

/** Build the footer line shown under the conversation body. */
export function buildTaskFooterLine(isRunning: boolean): string {
  return isRunning ? FOOTER_RUNNING : FOOTER_COMPLETE;
}

// ---------------------------------------------------------------------------
// Exit helper
// ---------------------------------------------------------------------------

/**
 * Exit task-view mode: clears `viewingTaskId`, repaint the status line,
 * and emits a brief return notice via `ctx.out`.
 */
export function exitTaskViewMode(entry: TaskViewEntry): void {
  if (entry.ictx) {
    entry.ictx.viewingTaskId = undefined;
  }
  entry.ctx.ui.repaintStatusLine();
  entry.ctx.out.line('');
  entry.ctx.out.line(FOOTER_RETURN);
}

// ---------------------------------------------------------------------------
// Disk-replay helper
// ---------------------------------------------------------------------------

/** Render all disk-log events for a subagent and return the line count. */
async function replayDiskEvents(
  entry: TaskViewEntry,
  limit = 500,
): Promise<number> {
  let count = 0;
  for await (const event of SubagentLogReader.readEvents(entry.sessionLabel, entry.id)) {
    if (count >= limit) break;
    const text = formatOutputEvent(event);
    if (text !== null) {
      entry.ctx.out.line(text);
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Enter live task-view mode for a given subagent.
 *
 * 1. Clears the screen and renders the history header.
 * 2. Replays disk events (history path) OR renders in-memory history.
 * 3. If the subagent is still running, tails live output events until it
 *    finishes or the user presses Esc.
 * 4. Wires Esc via `ctx.setSoftStopHandler` to call `exitTaskViewMode`.
 *
 * Returns once the subagent has completed (or Esc was pressed).
 */
export async function enterTaskViewMode(entry: TaskViewEntry): Promise<void> {
  const { id, manager, ctx, ictx } = entry;

  // Mark as viewing so the REPL loop knows we are in task-view mode.
  if (ictx) ictx.viewingTaskId = id;

  // Clear the screen before rendering the task view.
  ctx.ui.clearScreen();

  const handle = manager.get(id);
  const status  = handle ? handle.status : 'completed';
  const agentType = (handle as unknown as { _agentType?: string })?._agentType;

  // ── Memory-first: render from handle.session.getHistory() ────────────────
  // getHistory is optional on the interface — some session implementations
  // don't expose it. Fall through to disk replay when absent.
  // Invariant: the memory path renders via renderMessagesView (task-view.ts)
  // which truncates tool_use/tool_result content — never raw JSON.stringify.
  if (handle && typeof handle.session.getHistory === 'function') {
    const history = handle.session.getHistory();
    ctx.out.line(renderMessagesView({ id, status, agentType }, history));
    if (history.length === 0) {
      ctx.out.line(palette.dim('  (no history yet)'));
    }
    ctx.out.line('');
  } else {
    ctx.out.line(renderTaskViewHeader(id, status, agentType));
    ctx.out.line('');
    // ── Disk fallback: replay JSONL events ──────────────────────────────────
    const count = await replayDiskEvents(entry);
    if (count === 0) {
      ctx.out.line(palette.dim('  (no events recorded)'));
    }
    ctx.out.line('');
    // Disk-only means already completed — show footer and wire Esc.
    ctx.out.line(buildTaskFooterLine(false));
    wireEscapeToExit(entry);
    // Clear viewingTaskId since we are not blocking in a tail loop.
    if (ictx) ictx.viewingTaskId = undefined;
    // Clear the soft-stop handler we just installed — callers in the disk
    // path return immediately and never enter a tail loop, so the handler
    // must not linger as a stale closure (#1331).
    entry.ctx.setSoftStopHandler?.(null);
    return;
  }

  const isRunning = status === 'running' || status === 'idle';
  ctx.out.line(buildTaskFooterLine(isRunning));

  // Wire Esc → exit regardless of running/completed state.
  wireEscapeToExit(entry);

  // ── Completed subagents: render and return. ──────────────────────────────
  // viewingTaskId is cleared immediately since there's no blocking tail loop.
  if (!isRunning) {
    if (ictx) ictx.viewingTaskId = undefined;
    // Clear the soft-stop handler we just installed — callers in the
    // completed (in-memory) path return immediately and never enter a tail
    // loop, so the handler must not linger as a stale closure (#1338).
    entry.ctx.setSoftStopHandler?.(null);
    return;
  }

  // Abort controller so we can stop tailing when Esc is pressed.
  const abort = new AbortController();
  const { signal } = abort;

  // Override the Esc handler to also abort the tail loop.
  ctx.setSoftStopHandler?.(() => {
    abort.abort();
    exitTaskViewMode(entry);
    ctx.setSoftStopHandler?.(null);
  });

  try {
    await tailOutputStream(handle.session.getOutputStream(), ctx, signal);
  } catch {
    // Abort or any stream error — exit cleanly.
  } finally {
    // The subagent finished naturally (not Esc). Update footer and exit view.
    if (!signal.aborted) {
      ctx.out.line('');
      ctx.out.line(FOOTER_COMPLETE);
      exitTaskViewMode(entry);
      ctx.setSoftStopHandler?.(null);
    }
  }
}

// ---------------------------------------------------------------------------
// Live tail helpers
// ---------------------------------------------------------------------------

/**
 * Wire Esc to call `exitTaskViewMode` and clear the soft-stop handler.
 * Safe to call even when `setSoftStopHandler` is not wired (non-TTY surfaces).
 */
function wireEscapeToExit(entry: TaskViewEntry): void {
  entry.ctx.setSoftStopHandler?.(() => {
    exitTaskViewMode(entry);
    entry.ctx.setSoftStopHandler?.(null);
  });
}

/**
 * Iterate over a live output stream, rendering each event to `ctx.out`.
 * Stops when the stream is exhausted OR `signal` is aborted.
 */
async function tailOutputStream(
  stream: AsyncIterable<OutputEvent>,
  ctx: SlashContext,
  signal: AbortSignal,
): Promise<void> {
  for await (const event of stream) {
    if (signal.aborted) break;
    const text = formatOutputEvent(event);
    if (text !== null) {
      ctx.out.line(text);
    }
  }
}
