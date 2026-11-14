/**
 * Handler for the `list_schedules` tool.
 *
 * Extracted from `schedules.ts` to satisfy the 350-code-line ceiling.
 * Re-exported from `schedules.ts` — consumers import from there, not here.
 *
 * @module agent/tools/handlers/schedules.list
 */

import type { ToolHandler } from '../types.js';
import { loadSchedules } from '../../daemon/schedule-store.js';

export const listSchedulesHandler: ToolHandler = async (input, _signal) => {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const nameFilter = typeof obj['name'] === 'string' ? obj['name'].toLowerCase() : undefined;
  const enabledFilter = typeof obj['enabled'] === 'boolean' ? obj['enabled'] : undefined;

  let schedules = loadSchedules();
  if (nameFilter !== undefined) {
    schedules = schedules.filter((s) => s.name.toLowerCase().includes(nameFilter));
  }
  if (enabledFilter !== undefined) {
    schedules = schedules.filter((s) => s.enabled === enabledFilter);
  }

  return {
    content: JSON.stringify(
      schedules.map((s) => ({
        id: s.id,
        name: s.name,
        cron: s.cron,
        executor: s.executor ?? 'agent',
        trigger: s.trigger,
        enabled: s.enabled,
        notifyOn: s.notifyOn,
        ...(s.maxAttempts !== undefined ? { maxAttempts: s.maxAttempts } : {}),
        ...(s.retryDelayMs !== undefined ? { retryDelayMs: s.retryDelayMs } : {}),
        ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
        ...(s.runAt !== undefined ? { runAt: s.runAt } : {}),
        ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
      })),
    ),
  };
};
