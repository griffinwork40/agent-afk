/**
 * Session-status grouping and badge rendering for the sidebar.
 *
 * Groups a flat session list into three urgency tiers:
 *   1. needsInput  — sessions with a pending elicitation (Asking / Blocked)
 *   2. active      — sessions currently running (alive or owned + live)
 *   3. completed   — everything else
 *
 * Invariant: this module has no side effects and no module-scope state.
 * All functions are pure transforms over their arguments. Wiring into the
 * live sidebar belongs to the caller (Wave 2-Beta/Gamma).
 *
 * Invariant: NOTHING here uses innerHTML. Every user-visible string comes
 * from server-derived session metadata and is written with textContent only.
 * See render.ts for the full XSS rationale.
 */

import type { SessionSummary } from './render.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** The three urgency tiers the sidebar groups sessions into. */
export type SessionStatusGroup = 'needs-input' | 'active' | 'completed';

/**
 * Result of grouping a session list. Each array preserves the relative
 * ordering of the input (newest-first from the server).
 */
export interface SessionGroups {
  needsInput: SessionSummary[];
  active: SessionSummary[];
  completed: SessionSummary[];
}

// ── Classification ─────────────────────────────────────────────────────────────

/**
 * Derive the urgency tier for a single session.
 *
 * Contract: `pendingSessionIds` is the caller's responsibility. The server's
 * `/api/pending` endpoint returns elicitations with an optional `sessionId`;
 * the caller builds this set from those records. When the set is omitted
 * (undefined), no session is classified as `needs-input`.
 *
 * Classification rules:
 *   needs-input → session id appears in `pendingSessionIds`
 *   active      → mode === 'live' (owned by this process) OR alive === true
 *                 (another process confirmed running via presence file)
 *   completed   → everything else
 */
export function classifySession(
  session: SessionSummary,
  pendingSessionIds?: ReadonlySet<string>,
): SessionStatusGroup {
  if (pendingSessionIds?.has(session.id)) return 'needs-input';
  if (session.mode === 'live' || session.alive === true) return 'active';
  return 'completed';
}

/**
 * Group a flat session list into three urgency tiers.
 *
 * @param sessions - Flat list, newest-first (as returned by `/api/sessions`).
 * @param pendingSessionIds - Optional set of session ids that have at least
 *   one unresolved elicitation. Build from `/api/pending` records. When absent,
 *   no session is placed in the `needsInput` bucket.
 * @returns Three buckets preserving relative order within each tier.
 */
export function groupSessionsByStatus(
  sessions: SessionSummary[],
  pendingSessionIds?: ReadonlySet<string>,
): SessionGroups {
  const groups: SessionGroups = { needsInput: [], active: [], completed: [] };
  for (const s of sessions) {
    const tier = classifySession(s, pendingSessionIds);
    if (tier === 'needs-input') groups.needsInput.push(s);
    else if (tier === 'active') groups.active.push(s);
    else groups.completed.push(s);
  }
  return groups;
}

// ── Badge rendering ────────────────────────────────────────────────────────────

/** Display metadata for each status tier. */
const STATUS_META: Record<
  SessionStatusGroup,
  { label: string; dotClass: string; badgeClass: string }
> = {
  'needs-input': {
    label: 'Needs input',
    dotClass: 'status-dot status-dot-needs-input',
    badgeClass: 'badge badge-needs-input',
  },
  active: {
    label: 'Active',
    dotClass: 'status-dot status-dot-active',
    badgeClass: 'badge badge-active',
  },
  completed: {
    label: 'Completed',
    dotClass: 'status-dot status-dot-completed',
    badgeClass: 'badge badge-completed',
  },
};

/**
 * Build a small inline badge: a colored dot followed by a label span.
 *
 * The returned element uses only CSS classes for color — no inline styles —
 * so the stylesheet controls the exact palette. Classes follow the
 * `badge-*` and `status-dot-*` conventions already in styles.css.
 *
 * @returns A `<span class="status-badge ...">` containing a dot + label.
 */
export function renderStatusBadge(status: SessionStatusGroup): HTMLSpanElement {
  const { label, dotClass, badgeClass } = STATUS_META[status];

  const wrapper = document.createElement('span');
  wrapper.className = badgeClass;

  const dot = document.createElement('span');
  dot.className = dotClass;
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'status-badge-label';
  text.textContent = label;

  wrapper.appendChild(dot);
  wrapper.appendChild(text);
  return wrapper;
}

// ── Group header ───────────────────────────────────────────────────────────────

/**
 * Build a section-header `<div>` for one group.
 *
 * Contract: the header is OMITTED when the group is empty — callers should
 * check the array length and skip rendering when there are no sessions in
 * the bucket. This function always builds the element; skipping is the
 * caller's responsibility so the rendered list has no orphaned headers.
 */
function renderGroupHeader(status: SessionStatusGroup, count: number): HTMLDivElement {
  const { label } = STATUS_META[status];

  const header = document.createElement('div');
  header.className = 'session-group-header';
  header.setAttribute('data-group', status);

  const titleSpan = document.createElement('span');
  titleSpan.className = 'session-group-title';
  titleSpan.textContent = label;

  const countSpan = document.createElement('span');
  countSpan.className = 'session-group-count';
  countSpan.textContent = String(count);

  header.appendChild(titleSpan);
  header.appendChild(countSpan);
  return header;
}

// ── Grouped list rendering ─────────────────────────────────────────────────────

/**
 * Render one session row using the same visual structure as `renderSidebar`
 * in render.ts. Kept local so this module has no build-time circular dep on
 * render.ts; the Wave 2-Beta wiring step can consolidate if desired.
 */
function renderSessionRow(
  session: SessionSummary,
  activeId: string | undefined,
  onSelect: (id: string) => void,
  status: SessionStatusGroup,
): HTMLButtonElement {
  const row = document.createElement('button');
  row.className = 'session-row';
  if (session.id === activeId) row.classList.add('is-active');
  row.setAttribute('data-session-id', session.id);
  row.setAttribute('data-status', status);

  // Title — strip leading bracketed plugin tags (mirrors sessionLabel in render.ts)
  const stripped = (session.title ?? '').replace(/^\s*\[[^\]]{0,80}\]\s*/, '').trim();
  const label = stripped || session.title || session.id.slice(0, 8);
  const titleEl = document.createElement('span');
  titleEl.className = 'session-title';
  titleEl.textContent = label;
  row.appendChild(titleEl);

  // Meta row: cwd basename, status badge, relative time
  const meta = document.createElement('span');
  meta.className = 'session-meta';

  if (session.cwd) {
    const dir = session.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
    if (dir && dir !== '.') {
      const cwdEl = document.createElement('span');
      cwdEl.className = 'session-cwd';
      cwdEl.textContent = dir;
      cwdEl.title = session.cwd;
      meta.appendChild(cwdEl);
    }
  }

  // Status badge replaces the old live/read-only badge in grouped view
  meta.appendChild(renderStatusBadge(status));

  if (session.updatedAt) {
    const timeEl = document.createElement('span');
    timeEl.className = 'session-time';
    timeEl.textContent = relativeTime(session.updatedAt);
    meta.appendChild(timeEl);
  }

  row.appendChild(meta);
  row.addEventListener('click', () => onSelect(session.id));
  return row;
}

/**
 * Render the three-group session list into `container`, replacing any
 * previous content.
 *
 * Groups are ordered: needsInput > active > completed. Empty groups are
 * omitted (no orphaned section header). Each group renders a header
 * followed by its session rows.
 *
 * @param groups   - Output of {@link groupSessionsByStatus}.
 * @param container - The DOM node to populate (typically `#sessions`).
 * @param activeId  - The currently selected session id, or undefined.
 * @param onSelect  - Callback invoked when the user clicks a session row.
 */
export function renderGroupedSessionList(
  groups: SessionGroups,
  container: HTMLElement,
  activeId: string | undefined,
  onSelect: (id: string) => void,
): void {
  container.textContent = '';

  const orderedTiers: Array<{ key: keyof SessionGroups; status: SessionStatusGroup }> = [
    { key: 'needsInput', status: 'needs-input' },
    { key: 'active', status: 'active' },
    { key: 'completed', status: 'completed' },
  ];

  let totalRendered = 0;

  for (const { key, status } of orderedTiers) {
    const bucket = groups[key];
    if (bucket.length === 0) continue;

    container.appendChild(renderGroupHeader(status, bucket.length));
    for (const session of bucket) {
      container.appendChild(renderSessionRow(session, activeId, onSelect, status));
    }
    totalRendered += bucket.length;
  }

  if (totalRendered === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No sessions found.';
    container.appendChild(empty);
  }
}

// ── Local time helper ──────────────────────────────────────────────────────────

/**
 * Human-readable relative time string from an ISO 8601 timestamp.
 * Mirrors `relativeTime` in render.ts to avoid a cross-import.
 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
