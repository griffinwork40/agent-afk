/**
 * Shell executor for daemon scheduled tasks.
 *
 * Runs a command via `/bin/sh -c` with a wall-clock timeout, captures
 * stdout + stderr, and returns a telemetry record. No AgentSession is
 * spawned -- this is the lightweight path for simple cron jobs (backups,
 * health checks, log rotation).
 *
 * Mirrors the contract of `worktree-prune-task.ts` -- a standalone
 * async function called by the scheduler's executor dispatch.
 *
 * @module agent/daemon/shell-task
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { env } from '../../config/env.js';
import { redactInlineSecrets } from '../session/prompt-dump.js';
import type { TelemetryRecord, TelemetryTrigger } from './scheduler.js';

const execFile = promisify(execFileCb);

/** Tail cap for stdout/stderr carried in `responseExcerpt`. */
const EXCERPT_CAP = 4096;

/**
 * Contract: Slice `s` from `start`, bumping by 1 if `start` falls on a low
 * surrogate (0xDC00–0xDFFF) to avoid splitting a surrogate pair.
 */
function sliceSafe(s: string, start: number): string {
  const code = s.charCodeAt(start);
  const safe = start + (code >= 0xdc00 && code <= 0xdfff ? 1 : 0);
  return s.slice(safe);
}

export interface ShellTaskOptions {
  now: () => number;
  writeTelemetry: (record: TelemetryRecord) => void;
}

/**
 * Execute `task.command` as a shell command and return a telemetry record.
 *
 * Uses `execFile('/bin/sh', ['-c', command])` -- no `shell: true` flag on
 * the spawn options, so the command goes through exactly one shell
 * interpretation (same pattern as worktree-prune-task.ts).
 */
export async function runShellTask(
  task: { taskId: string; command: string; cronExpression?: string },
  trigger: TelemetryTrigger,
  options: ShellTaskOptions,
): Promise<TelemetryRecord> {
  const triggeredAt = new Date(options.now());
  const startTimeMs = options.now();
  const timeoutMs = parseInt(env.AFK_DAEMON_SHELL_TIMEOUT_MS ?? '', 10) || 2_700_000;
  const baseRecord: Pick<
    TelemetryRecord,
    'taskId' | 'command' | 'trigger' | 'cronExpression' | 'triggeredAt'
  > = {
    taskId: task.taskId,
    command: redactInlineSecrets(task.command),
    trigger,
    ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
    triggeredAt: triggeredAt.toISOString(),
  };

  try {
    const { stdout, stderr } = await execFile('/bin/sh', ['-c', task.command], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1 MB
      env: process.env,
    });
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    const excerpt = combined.length > EXCERPT_CAP
      ? sliceSafe(combined, combined.length - EXCERPT_CAP)
      : combined;
    const record: TelemetryRecord = {
      ...baseRecord,
      durationMs: options.now() - startTimeMs,
      status: 'success',
      responseExcerpt: redactInlineSecrets(excerpt),
    };
    options.writeTelemetry(record);
    return record;
  } catch (err) {
    const errObj = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
      killed?: boolean;
    };
    // On nonzero exit, execFile rejects but still carries stdout/stderr
    const combined = [errObj.stdout ?? '', errObj.stderr ?? ''].filter(Boolean).join('\n').trim();
    const excerpt = combined.length > EXCERPT_CAP
      ? sliceSafe(combined, combined.length - EXCERPT_CAP)
      : combined;
    const exitInfo = typeof errObj.code === 'number'
      ? `exit ${errObj.code}`
      : (errObj.killed === true
        ? 'killed (timeout)'
        : redactInlineSecrets(errObj.message ?? String(err)));
    const record: TelemetryRecord = {
      ...baseRecord,
      durationMs: options.now() - startTimeMs,
      status: 'error',
      errorMessage: exitInfo,
      ...(excerpt.length > 0 ? { responseExcerpt: redactInlineSecrets(excerpt) } : {}),
    };
    options.writeTelemetry(record);
    return record;
  }
}
