/**
 * Persist each completed daemon agent-task run as a session sidecar, so the
 * run appears in `/resume` (and is titled in the web session list) like any
 * REPL session. The message journal was already written by the session
 * itself; the sidecar is the index `/resume` lists from.
 *
 * Naming: the sidecar `name` is the task id (e.g. `morning-project-brief`),
 * not a slug of the command prompt, so a run is recognizable by the job that
 * produced it. Repeated runs share the name; `/resume` shows them newest
 * first and each stays resumable by its own session id.
 *
 * @module cli/commands/daemon-session-persist
 */

import type { AgentModelInput } from '../../agent/types.js';
import type { TaskTurnCompleteArgs } from '../../agent/daemon/scheduler.execute-agent-task.js';
import type { SchedulerOptions } from '../../agent/daemon/scheduler.js';
import { createSessionAutosaver } from '../session-autosave.js';

/** Build the scheduler's `onTaskTurnComplete` hook for a daemon using `model`. */
export function makeDaemonTurnPersister(model: AgentModelInput): (args: TaskTurnCompleteArgs) => void {
  return ({ task, sessionId, cwd, userInput, response }) => {
    // One daemon tick is one session with one turn, so a fresh autosaver per
    // run is exact (no cross-run state).
    const saver = createSessionAutosaver({
      model,
      source: 'daemon',
      name: task.taskId,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      onError: (err) => {
        console.error(`[daemon] ${task.taskId}: session sidecar save failed; run will not appear in /resume:`, err);
      },
    });
    saver.saveTurn(userInput, response.content, response.metadata);
  };
}

/**
 * The scheduler's turn-completion hooks, grouped so the daemon command wires
 * them in one place: the injected "Done"-verification probe and the sidecar
 * persister.
 */
export function daemonTurnHooks(
  model: AgentModelInput,
  doneUnverifiedProbe: NonNullable<SchedulerOptions['doneUnverifiedProbe']>,
): Pick<SchedulerOptions, 'doneUnverifiedProbe' | 'onTaskTurnComplete'> {
  return { doneUnverifiedProbe, onTaskTurnComplete: makeDaemonTurnPersister(model) };
}
