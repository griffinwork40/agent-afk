/**
 * Schedule-management and daemon-status routes, extracted from `server.ts`'s
 * `dispatch()` to keep it within the function/file size ceilings. Runs AFTER
 * dispatch's bearer and Origin gates — never call it before them.
 *
 * @module web-server/server.schedules
 */

import type { ServerResponse } from 'node:http';
import {
  handleCreateSchedule,
  handleDaemonStatus,
  handleDeleteSchedule,
  handleListSchedules,
  handleScheduleHistory,
  handleToggleSchedule,
  handleUpdateSchedule,
} from './routes.schedules.js';

/** Handle a schedule/daemon route. Returns false when `path` is not one. */
export async function dispatchScheduleRoute(
  res: ServerResponse,
  path: string,
  method: string,
  body: () => Promise<unknown>,
): Promise<boolean> {
  if (path === '/api/schedules' && method === 'GET') {
    await handleListSchedules(res);
    return true;
  }
  if (path === '/api/schedules' && method === 'POST') {
    await handleCreateSchedule(res, await body());
    return true;
  }
  const scheduleIdMatch = /^\/api\/schedules\/([^/]+)$/.exec(path);
  if (scheduleIdMatch?.[1] && method === 'PATCH') {
    await handleUpdateSchedule(res, decodeURIComponent(scheduleIdMatch[1]), await body());
    return true;
  }
  if (scheduleIdMatch?.[1] && method === 'DELETE') {
    await handleDeleteSchedule(res, decodeURIComponent(scheduleIdMatch[1]));
    return true;
  }
  const toggleMatch = /^\/api\/schedules\/([^/]+)\/toggle$/.exec(path);
  if (toggleMatch?.[1] && method === 'POST') {
    await handleToggleSchedule(res, decodeURIComponent(toggleMatch[1]));
    return true;
  }
  const historyMatch = /^\/api\/schedules\/([^/]+)\/history$/.exec(path);
  if (historyMatch?.[1] && method === 'GET') {
    await handleScheduleHistory(res, decodeURIComponent(historyMatch[1]));
    return true;
  }
  if (path === '/api/daemon/status' && method === 'GET') {
    await handleDaemonStatus(res);
    return true;
  }
  return false;
}
