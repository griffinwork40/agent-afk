import { loadSchedules } from '../../agent/daemon/schedule-store.js';
import { readStreakHistory } from '../../agent/daemon/scheduler.streak-history.js';
import { DEFAULT_FAILURE_STREAK_THRESHOLD } from '../../agent/daemon/scheduler.failure-streak.js';
import { getTelemetryPath } from '../../paths.js';
import { palette } from '../palette.js';

/** Parse the CLI threshold strictly, rejecting non-positive or unsafe integers. */
export function positiveThreshold(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error('failure streak threshold must be a positive integer');
  }
  return n;
}

/** Report bounded history; breaches and unknown boundaries set a non-zero exit code. */
export function runHealthCommand(fallback = DEFAULT_FAILURE_STREAK_THRESHOLD): void {
  const schedules = loadSchedules().filter((s) => s.enabled);
  let unhealthy = 0;
  for (const task of schedules) {
    const { snapshot: s, hasRuns } = readStreakHistory(getTelemetryPath(), task.id);
    const threshold = task.failureStreakThreshold ?? fallback;
    const prefix = `${task.id} (${task.name}), threshold ${threshold}: `;
    if (!hasRuns) {
      if (s.exact) {
        console.log(palette.dim(`${prefix}no runs yet`));
      } else {
        unhealthy++;
        console.log(palette.warning(`${prefix}no recent runs found (indeterminate; history boundary unavailable)`));
      }
      continue;
    }
    const count = `${s.exact ? '' : 'at least '}${s.count}`;
    if (s.count >= threshold) {
      unhealthy++;
      console.log(palette.error(`${prefix}${count} consecutive failures since ${s.failingSince ?? 'unknown'}`));
      if (s.lastError) console.log(palette.dim(`  Last error: ${s.lastError.slice(0, 120)}`));
    } else if (!s.exact) {
      unhealthy++;
      console.log(palette.warning(`${prefix}indeterminate (${count} failures; history boundary unavailable)`));
    } else {
      const since = s.failingSince ? ` since ${s.failingSince}` : '';
      console.log(palette.success(`${prefix}healthy (${count} consecutive failures${since})`));
    }
  }
  console.log(palette.dim(`--threshold is the fallback for tasks without a configured threshold (${fallback}).`));
  if (unhealthy > 0) process.exitCode = 1;
  else console.log(palette.success('All enabled tasks healthy.'));
}

/** List schedules with shared bounded history, distinguishing absent from unavailable old runs. */
export function printScheduleList(schedules: ReturnType<typeof loadSchedules>, telemetryPath: string): void {
  if (schedules.length === 0) {
    console.log(palette.dim('No scheduled tasks.'));
    return;
  }
  const hasCwd = schedules.some((s) => s.cwd !== undefined);
  const header = 'ID                   | NAME                           | CRON            | ENABLED | LAST STATUS'
    + ' | STREAK | FAILING SINCE | THRESHOLD' + (hasCwd ? ' | CWD' : '');
  console.log(palette.heading(header));
  console.log(palette.dim('-'.repeat(header.length)));
  for (const task of schedules) {
    const { snapshot: s, hasRuns, lastStatus } = readStreakHistory(telemetryPath, task.id);
    const status = !hasRuns
      ? (s.exact ? 'no runs yet' : 'no recent runs found')
      : lastStatus ?? 'indeterminate';
    const count = `${s.exact ? '' : '>='}${s.count}`;
    const row = [
      task.id.padEnd(20),
      task.name.padEnd(30),
      task.cron.padEnd(15),
      String(task.enabled).padEnd(7),
      status,
      count,
      s.failingSince ?? '',
      String(task.failureStreakThreshold ?? DEFAULT_FAILURE_STREAK_THRESHOLD),
    ];
    if (hasCwd) row.push(task.cwd ?? '');
    const line = row.join(' | ');
    console.log(s.count > 0 || !s.exact ? palette.warning(line) : palette.dim(line));
  }
}
