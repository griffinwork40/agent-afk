/**
 * Top-level view switching for `afk web` — sessions, schedules, bg-jobs, memory.
 *
 * Contract: switching toggles the `hidden` attribute on every view container
 * rather than destroying nodes, so the SSE stream stays alive while viewing
 * other panels — notifications are not missed.
 *
 * Invariant: visibility uses the `hidden` attribute exclusively. A global
 * `[hidden] { display: none !important }` rule in styles.css guarantees the
 * attribute wins over any element-level CSS `display` declaration, avoiding
 * the specificity fights that class-based toggling caused.
 *
 * Invariant: lazy singletons are module-scoped here and never exposed to
 * app.ts, keeping lifecycle self-contained in this file.
 */

import { SchedulesView } from './schedules-view.js';
import { openScheduleForm } from './schedule-form.js';
import { openScheduleHistory } from './schedule-history.js';
import { renderBgJobsPanel, type BgJobMeta } from './bg-jobs-panel.js';
import { createMemoryPanel } from './memory-panel.js';
import { showToast } from './app-chrome.js';

export type ApiFunction = <T>(path: string, init?: RequestInit) => Promise<T>;

export type ViewName = 'sessions' | 'schedules' | 'bg-jobs' | 'memory';

/** Lazy singleton — constructed on first switch to the schedules view. */
let schedulesView: SchedulesView | undefined;

/** Lazy singleton — constructed on first switch to the memory view. */
let memoryPanel: (HTMLElement & { refresh(): void }) | undefined;

/** AbortController for the in-flight bg-jobs fetch. Aborted on each view switch. */
let bgJobsAbortController: AbortController | undefined;

/** IDs of all nav buttons (toggled is-active). */
const NAV_IDS = ['nav-sessions', 'nav-schedules', 'nav-bg-jobs', 'nav-memory'] as const;

/** Session-view element IDs — shown when sessions tab is active. */
const SESSION_EL_IDS = ['transcript', 'approvals', 'composer'] as const;

/** Alternate view container IDs — one shown at a time, rest hidden. */
const ALT_VIEW_IDS = ['schedules-view', 'bg-jobs-view', 'memory-view'] as const;

/** Map from ViewName to the corresponding alt-view container id. */
const VIEW_CONTAINER_ID: Readonly<Record<Exclude<ViewName, 'sessions'>, string>> = {
  schedules: 'schedules-view',
  'bg-jobs': 'bg-jobs-view',
  memory: 'memory-view',
};

function setHidden(id: string, hide: boolean): void {
  const el = document.getElementById(id);
  if (el) el.hidden = hide;
}

/**
 * Switch between the top-level views.
 *
 * The sessions view includes transcript, approvals, and composer. Alternate
 * views are standalone panels that each get their own container.
 */
export function switchView(view: ViewName, api: ApiFunction): void {
  const isSessionsView = view === 'sessions';

  // Nav button active states
  for (const navId of NAV_IDS) {
    const btn = document.getElementById(navId);
    const btnView = btn?.getAttribute('data-view') ?? '';
    btn?.classList.toggle('is-active', btnView === view);
  }

  // Toggle session-view elements
  for (const id of SESSION_EL_IDS) setHidden(id, !isSessionsView);
  setHidden('sidebar-head', !isSessionsView);
  setHidden('sessions', !isSessionsView);

  // Toggle all alternate view containers — hide all, then show the target.
  for (const altId of ALT_VIEW_IDS) setHidden(altId, true);
  if (!isSessionsView) {
    setHidden(VIEW_CONTAINER_ID[view], false);
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
      // Abort any in-flight request from a previous visit to this view.
      bgJobsAbortController?.abort();
      bgJobsAbortController = new AbortController();
      const { signal } = bgJobsAbortController;
      void (async () => {
        try {
          const data = await api<{ jobs: BgJobMeta[] }>('/api/bg-jobs', { signal });
          renderBgJobsPanel(bgView, data.jobs);
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return;
          showToast(err instanceof Error ? err.message : 'Failed to load background jobs');
        }
      })();
    }
  }

  if (view === 'memory') {
    const memView = document.getElementById('memory-view');
    if (memView && !memoryPanel) {
      memoryPanel = createMemoryPanel({ api });
      memView.appendChild(memoryPanel);
    } else {
      memoryPanel?.refresh();
    }
  }
}
