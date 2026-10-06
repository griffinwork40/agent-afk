/**
 * `/sh` support for model-started background processes (`bash
 * run_in_background`, ids `proc-N`).
 *
 * The model's jobs live in their own registry, separate from the user's
 * `!&` jobs, but the operator must still see and stop whatever the agent
 * started. `/sh list` shows both; `/sh show proc-N` prints recent output and
 * the log path; `/sh kill proc-N` stops the job (recorded as a user cancel,
 * so the agent is told its job was killed).
 *
 * @module cli/slash/commands/sh.process-jobs
 */

import { palette } from '../../palette.js';
import { formatDuration } from '../../format-utils.js';
import type { SlashContext } from '../types.js';
import type { ProcessJobRegistry } from '../../../agent/shell-jobs/process-jobs.js';

let processJobsRef: ProcessJobRegistry | undefined;

/** Wired from the REPL footer setup when a process-job registry exists. */
export function setShProcessJobs(reg: ProcessJobRegistry | undefined): void {
  processJobsRef = reg;
}

/** Append the model-process section to `/sh list`. No-op when none exist. */
export function listProcessJobs(out: SlashContext['out']): void {
  const jobs = processJobsRef?.list() ?? [];
  if (jobs.length === 0) return;
  out.line(palette.dim('  model background processes (bash run_in_background):'));
  for (const job of jobs) {
    const dur = formatDuration((job.endedAt ?? Date.now()) - job.startedAt).padEnd(12);
    const cmd = job.command.length > 60 ? job.command.slice(0, 57) + '...' : job.command;
    const glyph = job.status === 'running' ? '▶' : job.status === 'completed' ? '✓' : '✗';
    out.line(`  ${glyph} ${job.id.padEnd(7)} ${job.status.padEnd(10)} ${dur} ${cmd}`);
  }
}

export function showProcessJob(out: SlashContext['out'], id: string): void {
  const job = processJobsRef?.get(id);
  if (!job) {
    out.error(`Job ${id} not found.`);
    return;
  }
  out.line(palette.dim(`$ ${job.command}`));
  const tail = processJobsRef?.tail(id, 8_000) ?? '';
  if (tail.length === 0) out.line(palette.dim('  (no output yet)'));
  else out.raw(tail.endsWith('\n') ? tail : tail + '\n');
  const exit = job.signal ? `signal ${job.signal}` : job.exitCode !== undefined ? `exit ${String(job.exitCode)}` : 'running';
  out.line(palette.dim(`  [${job.id} · ${job.status} · ${exit} · log ${job.logPath}]`));
}

export function killProcessJob(out: SlashContext['out'], id: string): void {
  const before = processJobsRef?.get(id);
  if (!before) {
    out.error(`Job ${id} not found.`);
    return;
  }
  if (before.status !== 'running') {
    out.warn(`${id} is not running (status: ${before.status}).`);
    return;
  }
  processJobsRef?.cancel(id, 'user');
  out.success(`Stopping ${id} (SIGTERM, then SIGKILL after a grace period).`);
}
