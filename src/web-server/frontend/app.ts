/**
 * `afk web` browser entry point.
 *
 * Contract: the token arrives as `?token=` on the document URL (the only place
 * a query token is accepted). It is stashed in memory and stripped from the
 * visible URL immediately, so it does not linger in the address bar, get
 * copy-pasted into a bug report, or land in the browser history entry.
 */

import { SessionStream } from './sse-client.js';
import {
  renderApprovals,
  renderSidebar,
  renderTranscript,
  type ApprovalAnswer,
  type PendingApproval,
  type SessionSummary,
} from './render.js';
import {
  accumulateTotals,
  ledgerRecordToItem,
  type LedgerRecordLike,
  type SessionTotals,
} from './ledger-adapter.js';
import { moveDown, moveUp, removeAt } from './queue-reorder.js';
import { isPinnedToBottom } from './scroll-pin.js';
import type { TranscriptItem } from './view-model.js';

const token = readAndScrubToken();

let sessions: SessionSummary[] = [];
let activeId: string | undefined;
let items: TranscriptItem[] = [];
let queue: string[] = [];
let totals: SessionTotals = { costUsd: 0, durationMs: 0, turns: 0 };
let stream: SessionStream | undefined;
let pending: PendingApproval[] = [];
let pendingTimer: ReturnType<typeof setInterval> | undefined;
/**
 * Whether a turn is in flight on the active session.
 *
 * Contract: this is tracked from TURN boundaries (a prompt accepted, then a
 * terminal `done`/`error` ledger record), NOT from the SSE connection status —
 * that reports transport state ('open', 'reconnecting'), which stays 'open'
 * across an entire idle session and would leave Stop showing forever.
 */
let turnActive = false;

function readAndScrubToken(): string {
  const params = new URLSearchParams(location.search);
  const t = params.get('token') ?? '';
  if (t) history.replaceState(null, '', location.pathname);
  return t;
}

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function scrollToBottom(node: HTMLElement): void {
  node.scrollTop = node.scrollHeight;
}

function activeSession(): SessionSummary | undefined {
  return sessions.find((s) => s.id === activeId);
}

function isLive(): boolean {
  return activeSession()?.mode === 'live';
}

async function loadSessions(): Promise<void> {
  const data = await api<{ sessions: SessionSummary[] }>('/api/sessions');
  sessions = data.sessions;
  if (activeId === undefined && sessions.length > 0) {
    const first = sessions[0];
    if (first) selectSession(first.id);
  }
  renderSidebar($('sessions'), sessions, activeId, selectSession);
}

function selectSession(id: string): void {
  activeId = id;
  items = [];
  queue = [];
  renderQueue();
  totals = { costUsd: 0, durationMs: 0, turns: 0 };
  stream?.stop();

  turnActive = false;
  renderSidebar($('sessions'), sessions, activeId, selectSession);
  renderTranscript($('transcript'), items);
  syncComposer();
  syncStop();

  stream = new SessionStream(id, token, {
    onEvent: (data) => {
      const frame = data as { record?: LedgerRecordLike };
      const record = frame.record;
      if (!record) return;
      if (record.kind === 'done' || record.kind === 'error') {
        turnActive = false;
        syncStop();
      }
      const item = ledgerRecordToItem(record);
      totals = accumulateTotals(totals, record);
      if (item) {
        items.push(item);
        // Invariant: sample the scroll position BEFORE re-rendering. The render
        // replaces the container's children, which resets scrollHeight, so a
        // read taken afterwards cannot distinguish "user was at the bottom"
        // from "user had scrolled up to read". Unconditional scrolling made
        // history unreadable on a live session: every arriving event yanked the
        // viewport back to the newest row mid-sentence.
        const wasPinned = isPinnedToBottom($('transcript'));
        renderTranscript($('transcript'), items);
        if (wasPinned) scrollToBottom($('transcript'));
      }
      renderMeter();
    },
    onStatus: (status) => {
      const node = $('status');
      node.textContent = status;
      node.className = `status status-${status}`;
      syncStop();
    },
  });
  stream.start();
}

function renderMeter(): void {
  const parts = [`${totals.turns} turns`];
  if (totals.costUsd > 0) parts.push(`$${totals.costUsd.toFixed(4)}`);
  if (totals.durationMs > 0) parts.push(`${(totals.durationMs / 1000).toFixed(1)}s`);
  $('meter').textContent = parts.join('  ·  ');
}

/**
 * Invariant: every control that would need to reach the agent is disabled for a
 * readonly session. Those sessions run in another OS process whose elicitation
 * handler is unreachable from here, so an enabled button would be one that can
 * never resolve — the server enforces the same boundary with a 409.
 */
function syncComposer(): void {
  const live = isLive();
  const input = $('prompt') as HTMLTextAreaElement;
  const send = $('send') as HTMLButtonElement;
  input.disabled = !live;
  send.disabled = !live;
  input.placeholder = live
    ? 'Message the agent…  (queues while it works)'
    : 'Read-only — this session runs in another process';
  $('composer').classList.toggle('is-readonly', !live);
}

/**
 * Show Stop only when it would do something: a turn running on a session this
 * process owns. A readonly session's turn lives in another process and cannot
 * be interrupted from here (the same 409 boundary the composer respects), so
 * offering the control would promise an action that always fails.
 */
function syncStop(): void {
  ($('stop') as HTMLButtonElement).hidden = !(turnActive && isLive());
}

function renderQueue(): void {
  const container = $('queue');
  container.textContent = '';
  queue.forEach((text, i) => {
    const row = document.createElement('div');
    row.className = 'queue-row';
    const label = document.createElement('span');
    label.className = 'queue-text';
    label.textContent = text;
    row.appendChild(label);
    for (const [glyph, fn] of [
      ['↑', () => { queue = moveUp(queue, i); }],
      ['↓', () => { queue = moveDown(queue, i); }],
      ['✕', () => { queue = removeAt(queue, i); }],
    ] as const) {
      const btn = document.createElement('button');
      btn.className = 'queue-btn';
      btn.textContent = glyph;
      btn.addEventListener('click', () => {
        fn();
        renderQueue();
      });
      row.appendChild(btn);
    }
    container.appendChild(row);
  });
}

async function flushQueue(): Promise<void> {
  if (activeId === undefined || !isLive()) return;
  while (queue.length > 0) {
    const [next, ...rest] = queue;
    queue = rest;
    renderQueue();
    if (next === undefined) break;
    await api(`/api/sessions/${encodeURIComponent(activeId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text: next }),
    });
    turnActive = true;
    syncStop();
  }
}

function wireComposer(): void {
  const input = $('prompt') as HTMLTextAreaElement;
  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    queue = [...queue, text];
    input.value = '';
    renderQueue();
    void flushQueue().catch((err: unknown) => {
      $('status').textContent = err instanceof Error ? err.message : 'send failed';
    });
  };
  $('send').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  });
}

/**
 * Start a session this process owns, then select it.
 *
 * Contract: the sidebar is refreshed BEFORE selecting, because `selectSession`
 * reads mode/cwd out of the cached `sessions` array to decide whether the
 * composer is live. Selecting an id the cache has never seen would render the
 * new session as read-only until the next 10s poll happened to correct it.
 */
async function createSession(): Promise<void> {
  const button = $('new-session') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'starting…';
  try {
    const { session } = await api<{ session: { id: string } }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadSessions();
    selectSession(session.id);
  } catch (err: unknown) {
    $('status').textContent = err instanceof Error ? err.message : 'could not start session';
  } finally {
    button.disabled = false;
    button.textContent = '+ New';
  }
}

/**
 * Poll for elicitations awaiting an answer.
 *
 * Invariant: polling runs process-wide rather than per-session, because a
 * blocked turn is blocked whichever session the operator happens to be looking
 * at. Scoping this to the active session would let a background session hang
 * silently on an approval nobody was shown.
 */
async function pollPending(): Promise<void> {
  const next = await api<{ pending: PendingApproval[] }>('/api/pending');
  const changed =
    next.pending.length !== pending.length ||
    next.pending.some((p, i) => p.id !== pending[i]?.id);
  pending = next.pending;
  if (changed) renderApprovals($('approvals'), pending, answerApproval);
}

function answerApproval(id: string, answer: ApprovalAnswer): void {
  const sessionId = pending.find((p) => p.id === id)?.sessionId ?? activeId;
  if (sessionId === undefined) return;
  // Optimistic removal is deliberate: the card's only job is to unblock the
  // turn, and the poll re-adds it within a second if the POST failed.
  pending = pending.filter((p) => p.id !== id);
  renderApprovals($('approvals'), pending, answerApproval);
  void api(`/api/sessions/${encodeURIComponent(sessionId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({ requestId: id, response: answer }),
  }).catch((err: unknown) => {
    $('status').textContent = err instanceof Error ? err.message : 'approval failed';
  });
}

async function stopTurn(): Promise<void> {
  if (activeId === undefined) return;
  await api(`/api/sessions/${encodeURIComponent(activeId)}/interrupt`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

async function main(): Promise<void> {
  wireComposer();
  $('new-session').addEventListener('click', () => void createSession());
  $('stop').addEventListener('click', () => {
    void stopTurn().catch((err: unknown) => {
      $('status').textContent = err instanceof Error ? err.message : 'stop failed';
    });
  });
  renderMeter();
  await loadSessions();
  setInterval(() => void loadSessions().catch(() => {}), 10_000);
  pendingTimer = setInterval(() => void pollPending().catch(() => {}), 1_000);
  void pollPending().catch(() => {});
  window.addEventListener('beforeunload', () => {
    if (pendingTimer) clearInterval(pendingTimer);
  });
}

void main().catch((err: unknown) => {
  $('status').textContent = err instanceof Error ? err.message : String(err);
});
