import type { ScheduledTask, TriggerMode } from './daemon/triggers.js';
import { getSchedule, toScheduledTask } from './daemon/schedule-store.js';

/** Parameters for {@link isShellExecutorTrusted}. */
interface ShellTrustParams {
  failureStreakThreshold?: number;
  taskId: string;
  command: string;
  cronExpression: string | undefined;
  trigger: TriggerMode | undefined;
  notifyOn: ScheduledTask['notifyOn'];
  notifyChat: number | string | undefined;
  cwd: string | undefined;
  maxAttempts?: number;
  retryDelayMs?: number;
  runAt: string | undefined;
  expiresAt: string | undefined;
}

/**
 * Returns true when a shell-executor POST /tasks request can be trusted —
 * i.e. the payload matches an enabled shell entry already persisted in the
 * schedule store. Extracted to keep handleRequestAsync under the 200-line ceiling.
 */
export function isShellExecutorTrusted(params: ShellTrustParams): boolean {
  const storedConfig = getSchedule(params.taskId);
  if (!storedConfig || !storedConfig.enabled || storedConfig.executor !== 'shell') return false;
  const canonical = toScheduledTask(storedConfig);
  // Normalize notifyOn to the effective default ('failure') so an omitted field
  // in the store entry and an omitted field in the request compare equal. A bare
  // === between two optional values would reject a valid sync when one side is
  // undefined and the other is 'failure' (the canonical default).
  const canonicalNotifyOn: ScheduledTask['notifyOn'] = canonical.notifyOn ?? 'failure';
  return (
    canonical.command === params.command &&
    canonical.cronExpression === (params.runAt !== undefined ? undefined : params.cronExpression) &&
    (canonical.trigger ?? 'cron') === (params.trigger ?? 'cron') &&
    canonicalNotifyOn === params.notifyOn &&
    canonical.notifyChat === params.notifyChat &&
    canonical.cwd === params.cwd &&
    canonical.failureStreakThreshold === params.failureStreakThreshold &&
    canonical.maxAttempts === params.maxAttempts &&
    canonical.retryDelayMs === params.retryDelayMs &&
    canonical.runAt === params.runAt &&
    canonical.expiresAt === params.expiresAt
  );
}

