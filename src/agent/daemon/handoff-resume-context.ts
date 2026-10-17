/**
 * Contract: origin context carried from a daemon task, through its handoff
 * record and the resume queue entry, back onto the synthetic task that resumes
 * it (#1416). Every field is optional and validated on read, so handoff and
 * queue files written before these fields existed (or hand-edited ones) still
 * load; an invalid field is dropped rather than failing the resume.
 *
 *   - `originalTaskId` — the id of the task that asked the question. A resume
 *     runs under a fresh queue id (lease bookkeeping), but the scheduler uses
 *     this id as its overlap identity so a cron fire of the same task cannot
 *     run concurrently with its own resume.
 *   - `cwd` — the task's pinned working directory (`ScheduledTask.cwd`).
 *   - `notifyOn` / `notifyChat` — the task's notification policy and target.
 *
 * Type-only imports on purpose: queue-store and lease-store both import this
 * module, so it must not import either at runtime.
 *
 * @module agent/daemon/handoff-resume-context
 */

import { isAbsolute } from 'node:path';
import type { ScheduledTask } from './triggers.js';

export interface HandoffResumeContext {
  originalTaskId?: string;
  cwd?: string;
  notifyOn?: 'failure' | 'always' | 'never';
  notifyChat?: number | string;
}

const NOTIFY_ON = new Set(['failure', 'always', 'never']);

function validNotifyChat(v: unknown): v is number | string {
  return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '');
}

/** Pick the validated resume-context fields from any record-shaped value. */
export function pickResumeFields(src: unknown): HandoffResumeContext {
  if (src === null || typeof src !== 'object') return {};
  const s = src as Record<string, unknown>;
  const { originalTaskId, cwd, notifyOn, notifyChat } = s;
  return {
    ...(typeof originalTaskId === 'string' && originalTaskId !== '' ? { originalTaskId } : {}),
    ...(typeof cwd === 'string' && isAbsolute(cwd) ? { cwd } : {}),
    ...(typeof notifyOn === 'string' && NOTIFY_ON.has(notifyOn)
      ? { notifyOn: notifyOn as HandoffResumeContext['notifyOn'] }
      : {}),
    ...(validNotifyChat(notifyChat) ? { notifyChat } : {}),
  };
}

/**
 * The resume context of a running task, stored on its handoff record. A task
 * that is itself a resume keeps the ORIGINAL task id (its overlap key).
 */
export function resumeContextFromTask(task: ScheduledTask): HandoffResumeContext {
  return pickResumeFields({
    originalTaskId: task.overlapKey ?? task.taskId,
    cwd: task.cwd,
    notifyOn: task.notifyOn,
    notifyChat: task.notifyChat,
  });
}

/** Overlap identity for the in-flight guard: the original task id for a resume. */
export function overlapKeyOf(task: Pick<ScheduledTask, 'taskId' | 'overlapKey'>): string {
  return task.overlapKey ?? task.taskId;
}
