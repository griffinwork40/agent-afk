/**
 * Background-job status panel for the `afk web` SPA.
 *
 * Contract: all DOM is built with createElement — never innerHTML. No inline
 * styles. CSS lives in bg-jobs.css. This module is a pure renderer: it takes
 * a BgJobMeta[] snapshot and replaces the container's children on each call.
 */

/** Mirror of the server-side BgJobMeta shape (src/agent/bg-job-log.ts). */
export interface BgJobMeta {
  jobId: string;
  subagentId: string;
  label: string;
  promptHash: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  parentSessionId?: string;
  stopReason?: string;
  schemaVersion: 1;
}

// ── helpers ─────────────────────────────────────────────────────────────────

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

function statusLabel(status: BgJobMeta['status']): string {
  switch (status) {
    case 'running': return 'running';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
  }
}

function badgeClass(status: BgJobMeta['status']): string {
  switch (status) {
    case 'running': return 'bgjob-badge bgjob-badge--running';
    case 'completed': return 'bgjob-badge bgjob-badge--completed';
    case 'failed': return 'bgjob-badge bgjob-badge--failed';
    case 'cancelled': return 'bgjob-badge bgjob-badge--cancelled';
  }
}

/**
 * Format duration from millisecond timestamps.
 * Contract: returns empty string when endedAt is absent (still running).
 */
function formatDuration(startedAt: number, endedAt?: number): string {
  if (endedAt === undefined) return '';
  const ms = endedAt - startedAt;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

/** Shorten model name for compact display (strip org prefixes). */
function shortModel(model: string): string {
  // e.g. "anthropic/claude-3-5-sonnet-20241022" → "claude-3-5-sonnet-20241022"
  const slash = model.lastIndexOf('/');
  return slash !== -1 ? model.slice(slash + 1) : model;
}

// ── row builder ──────────────────────────────────────────────────────────────

function buildJobRow(job: BgJobMeta): HTMLElement {
  const row = el('div', 'bgjob-row');

  // Status badge
  const badge = el('span', badgeClass(job.status), statusLabel(job.status));
  row.appendChild(badge);

  // Pulsing dot for running jobs
  if (job.status === 'running') {
    const pulse = el('span', 'bgjob-pulse');
    row.appendChild(pulse);
  }

  // Label + meta column
  const body = el('div', 'bgjob-body');

  const label = el('div', 'bgjob-label', job.label || '(no label)');
  body.appendChild(label);

  const meta = el('div', 'bgjob-meta');

  const modelSpan = el('span', 'bgjob-model', shortModel(job.model));
  meta.appendChild(modelSpan);

  const dur = formatDuration(job.startedAt, job.endedAt);
  if (dur) {
    const durSpan = el('span', 'bgjob-duration', dur);
    meta.appendChild(durSpan);
  }

  body.appendChild(meta);
  row.appendChild(body);

  return row;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Render the background jobs panel into `container`.
 *
 * Replaces children on every call — caller is responsible for polling
 * or SSE-driven refresh cadence.
 */
export function renderBgJobsPanel(
  container: HTMLElement,
  jobs: BgJobMeta[],
): void {
  container.textContent = '';

  const panel = el('div', 'bgjobs-panel');

  if (jobs.length === 0) {
    panel.appendChild(el('div', 'bgjobs-empty', 'No background jobs'));
    container.appendChild(panel);
    return;
  }

  for (const job of jobs) {
    panel.appendChild(buildJobRow(job));
  }

  container.appendChild(panel);
}
