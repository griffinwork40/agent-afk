/**
 * Top-level view switching for `afk web` — sessions vs. schedules.
 *
 * Contract: switching toggles DOM visibility rather than destroying nodes so
 * the SSE stream stays alive while viewing schedules; notifications are not
 * missed. The SchedulesView is constructed lazily on first use.
 *
 * Invariant: `schedulesView` is module-scoped here and never exposed to app.ts,
 * keeping the lazy-singleton lifecycle self-contained in this file.
 */

import { SchedulesView } from './schedules-view.js';
import { openScheduleForm } from './schedule-form.js';
import { openScheduleHistory } from './schedule-history.js';

export type ApiFunction = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Lazy singleton — constructed on first switch to the schedules view. */
let schedulesView: SchedulesView | undefined;

/**
 * Switch between the sessions and schedules top-level views.
 *
 * The sessions view includes transcript, approvals, and composer. The schedules
 * view is a standalone panel for CRUD of daemon-scheduled tasks. Switching
 * toggles visibility rather than destroying DOM -- the SSE stream stays alive
 * while viewing schedules so notifications are not missed.
 */
export function switchView(view: 'sessions' | 'schedules', api: ApiFunction): void {
  // Nav buttons
  const navSessions = document.getElementById('nav-sessions');
  const navSchedules = document.getElementById('nav-schedules');
  navSessions?.classList.toggle('is-active', view === 'sessions');
  navSchedules?.classList.toggle('is-active', view === 'schedules');

  // Session-view elements
  const transcript = document.getElementById('transcript');
  const approvals = document.getElementById('approvals');
  const composer = document.getElementById('composer');
  const sidebarHead = document.querySelector('.sidebar-head') as HTMLElement | null;
  const sessionsEl = document.getElementById('sessions');

  // Schedule-view element
  const schedView = document.getElementById('schedules-view');

  if (view === 'sessions') {
    if (transcript) transcript.style.display = '';
    if (approvals) approvals.style.display = '';
    if (composer) composer.style.display = '';
    if (sidebarHead) sidebarHead.style.display = '';
    if (sessionsEl) sessionsEl.style.display = '';
    schedView?.classList.remove('is-active');
  } else {
    if (transcript) transcript.style.display = 'none';
    if (approvals) approvals.style.display = 'none';
    if (composer) composer.style.display = 'none';
    if (sidebarHead) sidebarHead.style.display = 'none';
    if (sessionsEl) sessionsEl.style.display = 'none';
    schedView?.classList.add('is-active');

    if (!schedulesView && schedView) {
      schedulesView = new SchedulesView({
        container: schedView,
        api,
        onEdit: (schedule) =>
          openScheduleForm(schedule.id ? schedule : null, {
            api,
            onSaved: () => void schedulesView?.load(),
          }),
        onShowHistory: (id) => openScheduleHistory(id, api),
      });
    }
    void schedulesView?.load();
  }
}
