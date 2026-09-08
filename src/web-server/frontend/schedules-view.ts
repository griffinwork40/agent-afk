/**
 * Schedule list view for the `afk web` SPA.
 *
 * Renders the schedule table, toggle switches, delete actions, and wires
 * create/edit/history interactions. All DOM construction uses textContent
 * or typed element creation -- never innerHTML.
 */

import { showToast } from './app-chrome.js';

/** Shape returned by `GET /api/schedules`. */
export interface ScheduleConfig {
  id: string;
  name: string;
  command: string;
  cron: string;
  trigger?: 'cron' | 'sessionstart' | 'both';
  enabled: boolean;
  notifyOn?: 'failure' | 'always' | 'never';
  createdAt: string;
  updatedAt: string;
}

/** Shape returned by `GET /api/daemon/status`. */
interface DaemonStatus {
  running: boolean;
  tasks?: number;
  detail?: string;
}

interface SchedulesViewOptions {
  container: HTMLElement;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onEdit: (schedule: ScheduleConfig) => void;
  onShowHistory: (id: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Human-readable cron description (simple cases). */
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*' && min !== '*') {
    return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && dow !== '*' && hour !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = days[Number(dow)] ?? dow;
    return `${dayName} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && dow === '*' && hour === '*' && min !== '*') {
    return `Every hour at :${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && dow === '*' && hour === '*' && min === '*') {
    return 'Every minute';
  }
  return expr;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export class SchedulesView {
  private container: HTMLElement;
  private api: <T>(path: string, init?: RequestInit) => Promise<T>;
  private onEdit: (schedule: ScheduleConfig) => void;
  private onShowHistory: (id: string) => void;
  private schedules: ScheduleConfig[] = [];
  private daemonStatus: DaemonStatus = { running: false };

  constructor(opts: SchedulesViewOptions) {
    this.container = opts.container;
    this.api = opts.api;
    this.onEdit = opts.onEdit;
    this.onShowHistory = opts.onShowHistory;
  }

  async load(): Promise<void> {
    try {
      const [schedData, statusData] = await Promise.all([
        this.api<{ schedules: ScheduleConfig[] }>('/api/schedules'),
        this.api<DaemonStatus>('/api/daemon/status'),
      ]);
      this.schedules = schedData.schedules;
      this.daemonStatus = statusData;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'failed to load schedules');
    }
    this.render();
  }

  private render(): void {
    this.container.textContent = '';

    // Header
    const header = el('div', 'sched-header');
    const titleRow = el('div', 'sched-title-row');
    titleRow.appendChild(el('h2', 'sched-title', 'Schedules'));
    const addBtn = el('button', 'sched-add-btn', '+ New Schedule');
    addBtn.addEventListener('click', () =>
      this.onEdit({
        id: '',
        name: '',
        command: '',
        cron: '',
        enabled: true,
        createdAt: '',
        updatedAt: '',
      }),
    );
    titleRow.appendChild(addBtn);
    header.appendChild(titleRow);

    // Daemon status
    const statusRow = el('div', 'sched-daemon-status');
    const dot = el('span', this.daemonStatus.running ? 'sched-dot-ok' : 'sched-dot-off');
    statusRow.appendChild(dot);
    statusRow.appendChild(
      el(
        'span',
        'sched-daemon-text',
        this.daemonStatus.running
          ? `Daemon running (${this.daemonStatus.tasks ?? 0} tasks)`
          : 'Daemon not running',
      ),
    );
    header.appendChild(statusRow);
    this.container.appendChild(header);

    // Empty state
    if (this.schedules.length === 0) {
      const empty = el('div', 'sched-empty');
      empty.appendChild(el('div', 'sched-empty-icon', '\u23F0'));
      empty.appendChild(el('div', 'sched-empty-title', 'No schedules yet'));
      empty.appendChild(
        el('div', 'sched-empty-sub', 'Create a schedule to run tasks on a cron timer.'),
      );
      this.container.appendChild(empty);
      return;
    }

    // Schedule cards
    const list = el('div', 'sched-list');
    for (const s of this.schedules) {
      list.appendChild(this.renderCard(s));
    }
    this.container.appendChild(list);
  }

  private renderCard(s: ScheduleConfig): HTMLElement {
    const card = el('div', `sched-card${s.enabled ? '' : ' sched-card-disabled'}`);

    // Top row: name + toggle
    const topRow = el('div', 'sched-card-top');
    const nameEl = el('span', 'sched-card-name', s.name);
    topRow.appendChild(nameEl);

    const toggle = el('button', `sched-toggle${s.enabled ? ' is-on' : ''}`) as HTMLButtonElement;
    const toggleDot = el('span', 'sched-toggle-dot');
    toggle.appendChild(toggleDot);
    toggle.title = s.enabled ? 'Disable' : 'Enable';
    toggle.addEventListener('click', () => void this.toggleSchedule(s.id));
    topRow.appendChild(toggle);
    card.appendChild(topRow);

    // Schedule details
    const details = el('div', 'sched-card-details');
    const cronRow = el('div', 'sched-detail-row');
    cronRow.appendChild(el('span', 'sched-detail-label', 'Schedule'));
    const cronVal = el('span', 'sched-detail-value');
    cronVal.appendChild(el('span', undefined, describeCron(s.cron)));
    cronVal.appendChild(el('span', 'sched-cron-raw', s.cron));
    cronRow.appendChild(cronVal);
    details.appendChild(cronRow);

    const cmdRow = el('div', 'sched-detail-row');
    cmdRow.appendChild(el('span', 'sched-detail-label', 'Command'));
    cmdRow.appendChild(el('code', 'sched-detail-code', s.command));
    details.appendChild(cmdRow);

    if (s.trigger && s.trigger !== 'cron') {
      const trigRow = el('div', 'sched-detail-row');
      trigRow.appendChild(el('span', 'sched-detail-label', 'Trigger'));
      trigRow.appendChild(el('span', 'sched-detail-value', s.trigger));
      details.appendChild(trigRow);
    }

    const metaRow = el('div', 'sched-card-meta');
    metaRow.appendChild(el('span', 'sched-card-id', s.id));
    if (s.updatedAt) {
      metaRow.appendChild(el('span', 'sched-card-time', relativeTime(s.updatedAt)));
    }
    details.appendChild(metaRow);
    card.appendChild(details);

    // Actions row
    const actions = el('div', 'sched-card-actions');
    const histBtn = el('button', 'sched-action-btn', 'History');
    histBtn.addEventListener('click', () => this.onShowHistory(s.id));
    actions.appendChild(histBtn);

    const editBtn = el('button', 'sched-action-btn', 'Edit');
    editBtn.addEventListener('click', () => this.onEdit(s));
    actions.appendChild(editBtn);

    const deleteBtn = el('button', 'sched-action-btn sched-action-danger', 'Delete');
    deleteBtn.addEventListener('click', () => void this.deleteSchedule(s.id, s.name));
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    return card;
  }

  private async toggleSchedule(id: string): Promise<void> {
    try {
      await this.api(`/api/schedules/${encodeURIComponent(id)}/toggle`, { method: 'POST' });
      await this.load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'toggle failed');
    }
  }

  private async deleteSchedule(id: string, name: string): Promise<void> {
    if (!confirm(`Delete schedule "${name}"? This cannot be undone.`)) return;
    try {
      await this.api(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await this.load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'delete failed');
    }
  }
}
