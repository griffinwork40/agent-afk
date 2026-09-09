/**
 * `afk web` browser entry point — session selection, transcript, and approvals.
 *
 * Contract: the bearer token is read from the server-templated `<meta name=
 * "afk-token">` tag and is never written to a JS-readable store; a refresh is
 * authenticated by the server's HttpOnly cookie rather than by anything this
 * script holds. See `web-token.ts` for why that replaced the cookie mirror.
 * The queue/composer concern lives in `queue-panel.ts`.
 */

import { readAndScrubToken } from './web-token.js';
import { SessionStream } from './sse-client.js';
import { wireComposerAffordances } from './composer-wiring.js';
import { showToast, wireSidebarClose, toggleNewSessionForm } from './app-chrome.js';
import { $required as $ } from './dom-utils.js';
import type { CommandEntry } from '../../cli/input/slash-match.js';
import {
  renderSidebar,
  renderTranscript,
  type SessionSummary,
} from './render.js';
import { wireAtFileAffordance } from './at-file-panel.js';
import {
  accumulateTotals,
  ledgerRecordToItem,
  resetIdCounter,
  type LedgerRecordLike,
  type SessionTotals,
} from './ledger-adapter.js';
import type { ToolCallItem, SubagentItem, TranscriptItem } from './view-model.js';
import { resetNodeCache } from './render-incremental.js';
import { QueuePanel } from './queue-panel.js';
import { isPinnedToBottom } from './scroll-pin.js';
import { createApprovalsManager } from './app-approvals.js';
import { switchView } from './app-views.js';

const token = readAndScrubToken();

let sessions: SessionSummary[] = [];
let activeId: string | undefined;
let items: TranscriptItem[] = [];
let totals: SessionTotals = { costUsd: 0, durationMs: 0, turns: 0 };
let stream: SessionStream | undefined;
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

/** True while the SSE transport is in a reconnecting state. */
let sseReconnecting = false;

/**
 * Contract: constructed lazily on first use so this module can be imported
 * before the DOM exists (the bundle is a `type="module"` script, but the
 * queue-reorder tests and any future harness import it directly).
 */
let queuePanel: QueuePanel | undefined;

function panel(): QueuePanel {
  if (!queuePanel) {
    queuePanel = new QueuePanel({
      container: $('queue'),
      input: $('prompt') as HTMLTextAreaElement,
      send: $('send'),
      submit: async (text: string) => {
        if (activeId === undefined) throw new Error('no active session');
        await api(`/api/sessions/${encodeURIComponent(activeId)}/prompt`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
      },
      isLive,
      isTurnActive: () => turnActive,
      onAccepted: () => {
        turnActive = true;
        syncStop();
      },
      onError: (message: string) => {
        showToast(message);
      },
    });
  }
  return queuePanel;
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
  // Contract: a 401 is reported as a recovery INSTRUCTION, not as the raw
  // server body. It has one dominant cause the user can act on: this document
  // was authenticated by the reload cookie alone, so it carried no bearer token
  // and sessionStorage is empty — the state a NEW TAB opened on the bare URL is
  // always in, because sessionStorage is scoped per tab. Reporting
  // `401 {"error":"unauthorized",...}` there states the failure without naming
  // the fix, and the sidebar renders empty behind it.
  if (res.status === 401) {
    const msg =
      'Session credential missing — reopen the URL printed by `afk web`. ' +
      'A new tab does not inherit the credential from the first one.';
    // Write to #status directly so the recovery instruction is visible even
    // when the sidebar is empty and the SSE stream has not opened yet. The
    // toast layer may not be visible if the layout has not rendered.
    try {
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.textContent = msg;
    } catch {
      // DOM unavailable (e.g. non-browser context); ignore.
    }
    throw new Error(msg);
  }
  if (!res.ok) {
    const body = await res.text();
    let msg = `${res.status} ${body}`;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed['message'] === 'string') msg = parsed['message'];
    } catch { /* body isn't JSON — use raw text */ }
    throw new Error(msg);
  }
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
  const snapshotId = id;
  items = [];
  resetIdCounter();
  resetNodeCache();
  const toolIndex = new Map<string, ToolCallItem>();
  const subagentIndex = new Map<string, SubagentItem>();
  panel().clear();
  totals = { costUsd: 0, durationMs: 0, turns: 0 };
  stream?.stop();

  turnActive = false;
  sseReconnecting = false;
  renderSidebar($('sessions'), sessions, activeId, selectSession);
  renderTranscript($('transcript'), items);
  syncComposer();
  syncStop();

  stream = new SessionStream(id, token, {
    onEvent: (data) => {
      if (activeId !== snapshotId) return;
      const frame = data as { record?: LedgerRecordLike; error?: string };
      if (frame.error) {
        showToast(`Stream error: ${frame.error}`);
        return;
      }
      const record = frame.record;
      if (!record) return;
      if (record.kind === 'done' || record.kind === 'error') {
        turnActive = false;
        syncStop();
        // The turn that was holding the queue just ended — release exactly one
        // more entry. This is the only place the drain resumes, which is what
        // keeps the queue a queue rather than a write-through.
        void panel().flush();
      }
      const item = ledgerRecordToItem(record, toolIndex, subagentIndex);
      totals = accumulateTotals(totals, record);
      if (item) {
        items.push(item);
        // Invariant: sample the scroll position BEFORE re-rendering. The render
        // replaces the container's children, which resets scrollHeight, so a
        // read taken afterwards cannot distinguish "user was at the bottom"
        // from "user had scrolled up to read". Unconditional scrolling made
        // history unreadable on a live session: every arriving event yanked the
        // viewport back to the newest row mid-sentence.
        const transcriptEl = $('transcript');
        const wasPinned = !transcriptEl.hidden && isPinnedToBottom(transcriptEl);
        renderTranscript(transcriptEl, items);
        if (wasPinned) scrollToBottom(transcriptEl);
      }
      renderMeter();
    },
    onStatus: (status) => {
      if (activeId !== snapshotId) return;
      const node = $('status');
      // Report the session's end honestly. 'ended' means the ledger reached its
      // terminal record and no further frame can arrive, so the indicator must
      // neither sit on 'reconnecting' (it is not retrying) nor read 'open' (the
      // stream is gone). A turn cannot be in flight on a session that has
      // ended, so the Stop control goes with it.
      node.textContent = status === 'ended' ? 'session ended' : status;
      node.className = `status status-${status}`;
      if (status === 'ended') turnActive = false;
      // Disable the composer while the transport is reconnecting so prompts
      // cannot be submitted against a broken stream.
      sseReconnecting = status === 'reconnecting' || status === 'connecting';
      syncComposer();
      syncStop();
    },
  });
  stream.start();
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function renderMeter(): void {
  const parts = [`${totals.turns} turns`];
  if (totals.costUsd > 0) parts.push(`$${totals.costUsd.toFixed(4)}`);
  const totalTokens = (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0);
  if (totalTokens > 0) parts.push(`${fmtTokens(totalTokens)} tokens`);
  if (totals.durationMs > 0) parts.push(`${(totals.durationMs / 1000).toFixed(1)}s`);
  $('meter').textContent = parts.join('  ·  ');
}

/**
 * Invariant: every control that would need to reach the agent is disabled for a
 * readonly session. Those sessions run in another OS process whose elicitation
 * handler is unreachable from here, so an enabled button would be one that can
 * never resolve — the server enforces the same boundary with a 409.
 *
 * Additionally, the composer is disabled while the SSE transport is reconnecting
 * so a queued prompt cannot be sent against a broken stream.
 */
function syncComposer(): void {
  const live = isLive();
  const input = $('prompt') as HTMLTextAreaElement;
  const send = $('send') as HTMLButtonElement;
  const blocked = !live || sseReconnecting;
  input.disabled = blocked;
  send.disabled = blocked;
  input.placeholder = !live
    ? 'Read-only — this session runs in another process'
    : sseReconnecting
      ? 'Reconnecting…'
      : 'Message the agent…  (queues while it works)';
  $('composer').classList.toggle('is-readonly', !live);
  $('composer').classList.toggle('is-reconnecting', live && sseReconnecting);
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

/**
 * Start a session this process owns, then select it.
 *
 * Contract: the sidebar is refreshed BEFORE selecting, because `selectSession`
 * reads mode/cwd out of the cached `sessions` array to decide whether the
 * composer is live. Selecting an id the cache has never seen would render the
 * new session as read-only until the next 10s poll happened to correct it.
 */
async function createSession(model: string, cwd: string): Promise<void> {
  const button = $('new-session') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'starting…';
  const snapshotId = activeId;
  try {
    const body: Record<string, string> = { model };
    if (cwd) body['cwd'] = cwd;
    const { session } = await api<{ session: { id: string } }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await loadSessions();
    if (activeId !== snapshotId && activeId !== session.id) return;
    selectSession(session.id);
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : 'could not start session');
  } finally {
    button.disabled = false;
    button.textContent = '+ New';
  }
}

async function stopTurn(): Promise<void> {
  if (activeId === undefined) return;
  const stopBtn = $('stop') as HTMLButtonElement;
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping…';
  try {
    await api(`/api/sessions/${encodeURIComponent(activeId)}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (err) {
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    throw err;
  }
}

async function main(): Promise<void> {
  // Invariant: composer affordances are wired BEFORE the composer itself. Both
  // bind keydown on the same textarea and listeners fire in attachment order,
  // so the slash menu must claim Enter before QueuePanel's submit handler runs.
  // Reversing these two lines silently sends the prompt instead of accepting
  // the highlighted candidate.
  wireComposerAffordances({
    input: $('prompt') as HTMLTextAreaElement,
    loadCommands: async () => (await api<{ commands: CommandEntry[] }>('/api/commands')).commands,
  });
  panel().wire();
  const composerRow = document.querySelector('.composer-row');
  if (composerRow instanceof HTMLElement) {
    wireAtFileAffordance({ input: $('prompt') as HTMLTextAreaElement, container: composerRow });
  }
  $('new-session').addEventListener('click', () => toggleNewSessionForm(
    (model, cwd) => void createSession(model, cwd),
  ));

  // Wire nav tab switching
  document.getElementById('nav-sessions')?.addEventListener('click', () => switchView('sessions', api));
  document.getElementById('nav-schedules')?.addEventListener('click', () => switchView('schedules', api));
  document.getElementById('nav-bg-jobs')?.addEventListener('click', () => switchView('bg-jobs', api));
  document.getElementById('nav-memory')?.addEventListener('click', () => switchView('memory', api));
  wireSidebarClose();
  $('stop').addEventListener('click', () => {
    void stopTurn().catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : 'stop failed');
    });
  });
  renderMeter();
  await loadSessions();
  setInterval(() => void loadSessions().catch(() => {}), 10_000);

  const approvals = createApprovalsManager(api, $('approvals'));
  pendingTimer = setInterval(() => void approvals.pollPending().catch(() => {}), 1_000);
  void approvals.pollPending().catch(() => {});
  window.addEventListener('beforeunload', () => {
    if (pendingTimer) clearInterval(pendingTimer);
  });
}

void main().catch((err: unknown) => {
  showToast(err instanceof Error ? err.message : String(err));
});
