/**
 * Schedule execution history overlay for the `afk web` SPA.
 *
 * Fetches and renders the last 20 executions of a scheduled task.
 * All DOM construction uses textContent -- never innerHTML.
 */

import { showToast } from './app-chrome.js';

/** Shape of a telemetry record from `GET /api/schedules/:id/history`. */
interface HistoryRecord {
  taskId: string;
  command?: string;
  trigger?: string;
  triggeredAt: string;
  durationMs: number;
  status: 'success' | 'error' | 'skipped';
  errorMessage?: string;
  responseExcerpt?: string;
  skipReason?: string;
  name?: string;
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remainder = Math.floor(s % 60);
  return `${m}m ${remainder}s`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function openScheduleHistory(
  scheduleId: string,
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
): void {
  // Remove any existing history overlay
  document.getElementById('sched-history-overlay')?.remove();

  const overlay = el('div', 'sched-overlay');
  overlay.id = 'sched-history-overlay';

  const modal = el('div', 'sched-modal sched-modal-wide');
  modal.appendChild(el('h3', 'sched-modal-title', `History: ${scheduleId}`));

  const body = el('div', 'sched-history-body');
  body.appendChild(el('div', 'sched-history-loading', 'Loading...'));
  modal.appendChild(body);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };

  const closeBtn = el('button', 'sched-cancel-btn', 'Close');
  closeBtn.addEventListener('click', close);
  modal.appendChild(closeBtn);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Close on Escape or overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', escHandler);

  // Fetch and render
  void loadHistory(scheduleId, api, body);
}

async function loadHistory(
  id: string,
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
  container: HTMLElement,
): Promise<void> {
  try {
    const data = await api<{ history: HistoryRecord[] }>(
      `/api/schedules/${encodeURIComponent(id)}/history`,
    );
    container.textContent = '';

    if (data.history.length === 0) {
      container.appendChild(el('div', 'sched-empty', 'No executions recorded yet.'));
      return;
    }

    // Render newest first
    const reversed = [...data.history].reverse();
    for (const record of reversed) {
      container.appendChild(renderRecord(record));
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'failed to load history');
    container.textContent = '';
    container.appendChild(el('div', 'sched-empty', 'Failed to load history.'));
  }
}

function renderRecord(r: HistoryRecord): HTMLElement {
  const row = el('div', `sched-hist-row sched-hist-${r.status}`);

  // Status dot + time
  const header = el('div', 'sched-hist-header');
  const dot = el('span', `sched-hist-dot sched-hist-dot-${r.status}`);
  header.appendChild(dot);
  header.appendChild(el('span', 'sched-hist-status', r.status));
  header.appendChild(el('span', 'sched-hist-time', formatTime(r.triggeredAt)));
  header.appendChild(el('span', 'sched-hist-duration', formatDuration(r.durationMs)));
  if (r.trigger) {
    header.appendChild(el('span', 'sched-hist-trigger', r.trigger));
  }
  row.appendChild(header);

  // Error message if any
  if (r.status === 'error' && r.errorMessage) {
    const errEl = el('div', 'sched-hist-error', r.errorMessage);
    row.appendChild(errEl);
  }

  // Skip reason
  if (r.status === 'skipped' && r.skipReason) {
    row.appendChild(el('div', 'sched-hist-skip', `Skipped: ${r.skipReason}`));
  }

  // Response excerpt
  if (r.responseExcerpt) {
    const excerpt = el('div', 'sched-hist-excerpt', r.responseExcerpt);
    row.appendChild(excerpt);
  }

  return row;
}
