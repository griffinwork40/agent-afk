/**
 * `afk web` browser entry point.
 *
 * Contract: the token arrives as `?token=` on the document URL (the only place
 * a query token is accepted). It is stashed in memory and stripped from the
 * visible URL immediately, so it does not linger in the address bar, get
 * copy-pasted into a bug report, or land in the browser history entry.
 */

import { SessionStream } from './sse-client.js';
import { renderSidebar, renderTranscript, type SessionSummary } from './render.js';
import {
  accumulateTotals,
  ledgerRecordToItem,
  type LedgerRecordLike,
  type SessionTotals,
} from './ledger-adapter.js';
import { moveDown, moveUp, removeAt } from './queue-reorder.js';
import type { TranscriptItem } from './view-model.js';

const token = readAndScrubToken();

let sessions: SessionSummary[] = [];
let activeId: string | undefined;
let items: TranscriptItem[] = [];
let queue: string[] = [];
let totals: SessionTotals = { costUsd: 0, durationMs: 0, turns: 0 };
let stream: SessionStream | undefined;

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
  totals = { costUsd: 0, durationMs: 0, turns: 0 };
  stream?.stop();

  renderSidebar($('sessions'), sessions, activeId, selectSession);
  renderTranscript($('transcript'), items);
  syncComposer();

  stream = new SessionStream(id, token, {
    onEvent: (data) => {
      const frame = data as { record?: LedgerRecordLike };
      const record = frame.record;
      if (!record) return;
      const item = ledgerRecordToItem(record);
      totals = accumulateTotals(totals, record);
      if (item) {
        items.push(item);
        renderTranscript($('transcript'), items);
        $('transcript').scrollTop = $('transcript').scrollHeight;
      }
      renderMeter();
    },
    onStatus: (status) => {
      const node = $('status');
      node.textContent = status;
      node.className = `status status-${status}`;
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

async function main(): Promise<void> {
  wireComposer();
  renderMeter();
  await loadSessions();
  setInterval(() => void loadSessions().catch(() => {}), 10_000);
}

void main().catch((err: unknown) => {
  $('status').textContent = err instanceof Error ? err.message : String(err);
});
