/**
 * Top-level view switching for `afk web` — sessions, schedules, bg-jobs, memory.
 *
 * Contract: switching toggles DOM visibility rather than destroying nodes so
 * the SSE stream stays alive while viewing other panels; notifications are not
 * missed. The SchedulesView and memory panel are constructed lazily on first use.
 *
 * Invariant: lazy singletons are module-scoped here and never exposed to app.ts,
 * keeping lifecycle self-contained in this file.
 */

import { SchedulesView } from './schedules-view.js';
import { openScheduleForm } from './schedule-form.js';
import { openScheduleHistory } from './schedule-history.js';
import { renderBgJobsPanel, type BgJobMeta } from './bg-jobs-panel.js';
import { createMemoryPanel } from './memory-panel.js';

export type ApiFunction = <T>(path: string, init?: RequestInit) => Promise<T>;

export type ViewName = 'sessions' | 'schedules' | 'bg-jobs' | 'memory';

/** Lazy singleton — constructed on first switch to the schedules view. */
let schedulesView: SchedulesView | undefined;

/** Lazy singleton — constructed on first switch to the memory view. */
let memoryPanel: HTMLElement | undefined;

/** IDs of all non-session-view containers (toggled hidden when showing sessions). */
const ALT_VIEW_IDS = ['schedules-view', 'bg-jobs-view', 'memory-view'] as const;

/** IDs of all nav buttons (toggled is-active). */
const NAV_IDS = ['nav-sessions', 'nav-schedules', 'nav-bg-jobs', 'nav-memory'] as const;

/** Map from ViewName to the corresponding view container id. */
const VIEW_CONTAINER_ID: Readonly<Record<ViewName, string>> = {
  sessions: '',
  schedules: 'schedules-view',
  'bg-jobs': 'bg-jobs-view',
  memory: 'memory-view',
};

/**
 * Switch between the top-level views.
 *
 * The sessions view includes transcript, approvals, and composer. Alternate
 * views are standalone panels. Switching toggles visibility rather than
 * destroying DOM -- the SSE stream stays alive while viewing other panels so
 * notifications are not missed.
 */
export function switchView(view: ViewName, api: ApiFunction): void {
  // Nav button active states
  for (const navId of NAV_IDS) {
    const btn = document.getElementById(navId);
    const btnView = btn?.getAttribute('data-view') ?? '';
    btn?.classList.toggle('is-active', btnView === view);
  }

  // Session-view elements
  const transcript = document.getElementById('transcript');
  const approvals = document.getElementById('approvals');
  const composer = document.getElementById('composer');
  const sidebarHead = document.querySelector('.sidebar-head') as HTMLElement | null;
  const sessionsEl = document.getElementById('sessions');

  const isSessionsView = view === 'sessions';

  // Toggle session-view elements
  if (transcript) transcript.hidden = !isSessionsView;
  if (approvals) approvals.hidden = !isSessionsView;
  if (composer) composer.hidden = !isSessionsView;
  if (sidebarHead) sidebarHead.hidden = !isSessionsView;
  if (sessionsEl) sessionsEl.hidden = !isSessionsView;

  // Toggle all alternate view containers — deactivate every alt view, then
  // activate the requested one (if it's not sessions).
  for (const altId of ALT_VIEW_IDS) {
    document.getElementById(altId)?.classList.remove('is-active');
  }

  if (!isSessionsView) {
    const targetId = VIEW_CONTAINER_ID[view];
    document.getElementById(targetId)?.classList.add('is-active');
  }

  // Per-view lazy initialisation and data loading
  if (view === 'schedules') {
    const schedView = document.getElementById('schedules-view');
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

  if (view === 'bg-jobs') {
    const bgView = document.getElementById('bg-jobs-view');
    if (bgView) {
      void (async () => {
        try {
          const data = (await api<{ jobs: BgJobMeta[] }>('/api/bg-jobs'));
          renderBgJobsPanel(bgView, data.jobs);
        } catch {
          // Non-fatal: render empty panel on error.
          renderBgJobsPanel(bgView, []);
        }
      })();
    }
  }

  if (view === 'memory') {
    const memView = document.getElementById('memory-view');
    if (memView && !memoryPanel) {
      memoryPanel = createMemoryPanel({ api });
      memView.appendChild(memoryPanel);
    }
  }
}
