/**
 * DOM rendering for the transcript and sidebar.
 *
 * Invariant: NOTHING here uses innerHTML with model- or server-derived text.
 * Every value that originates from an agent, a tool, or a file path is placed
 * with textContent. Tool output is attacker-influencable (an agent can be made
 * to cat a crafted file), so treating it as markup would be a stored-XSS hole
 * in a page that holds a live bearer token.
 *
 * Assistant prose is the one value rendered as anything richer than flat text,
 * and it does NOT weaken that rule: `renderMarkdown` builds DOM nodes from
 * marked's token stream and never emits an HTML string. See markdown-dom.ts.
 */

import { stripAnsi } from './ansi-strip.js';
import { renderMarkdown } from './markdown-dom.js';
import type { TranscriptItem, ToolCallItem } from './view-model.js';

/** Beyond this, tool output is collapsed behind a "show full" control. */
const OUTPUT_PREVIEW_CHARS = 2_000;

export interface SessionSummary {
  id: string;
  mode: 'live' | 'readonly';
  cwd?: string;
  surface?: string;
  updatedAt?: string;
  title?: string;
  alive?: boolean;
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

/** Trailing path segment of `cwd`, or undefined when absent/degenerate. */
function basename(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

/**
 * Contract: strips a leading bracketed tag from a derived title.
 *
 * Plugin-dispatched sessions open with a `[plugin-name: unlocked] …` preamble
 * that pushes the distinguishing words past the truncation point. Removing it
 * surfaces more signal per row. Falls back to the raw title, then to a short id
 * — a row must never render blank.
 */
function sessionLabel(s: SessionSummary): string {
  const stripped = (s.title ?? '').replace(/^\s*\[[^\]]{0,80}\]\s*/, '').trim();
  return stripped || s.title || s.id.slice(0, 8);
}

export function renderSidebar(
  container: HTMLElement,
  sessions: SessionSummary[],
  activeId: string | undefined,
  onSelect: (id: string) => void,
): void {
  container.textContent = '';
  for (const s of sessions) {
    const row = el('button', 'session-row');
    if (s.id === activeId) row.classList.add('is-active');

    const title = el('span', 'session-title', sessionLabel(s));
    row.appendChild(title);

    const meta = el('span', 'session-meta');
    // Invariant: cwd is load-bearing for telling rows apart, not decoration.
    // Titles derive from a session's FIRST user message, which for plugin- and
    // skill-dispatched sessions is identical boilerplate — a real listing here
    // measured 6 distinct titles across 100 sessions, 90 of them sharing one
    // string. The working directory is the field that actually varies, so it is
    // rendered first and given the strongest treatment in the meta row.
    const dir = basename(s.cwd);
    if (dir) meta.appendChild(el('span', 'session-cwd', dir));
    // A readonly session lives in another OS process; its approvals are
    // unreachable from here. The badge is the user-facing half of that
    // contract — the composer is disabled to match.
    const badge = el('span', s.mode === 'live' ? 'badge badge-live' : 'badge badge-readonly');
    badge.textContent = s.mode === 'live' ? 'live' : 'read-only';
    meta.appendChild(badge);
    if (s.alive) meta.appendChild(el('span', 'badge badge-alive', 'running'));
    if (s.updatedAt) meta.appendChild(el('span', 'session-time', relativeTime(s.updatedAt)));
    row.appendChild(meta);

    row.addEventListener('click', () => onSelect(s.id));
    container.appendChild(row);
  }
  if (sessions.length === 0) {
    container.appendChild(el('div', 'empty', 'No sessions found.'));
  }
}

export function renderTranscript(container: HTMLElement, items: TranscriptItem[]): void {
  container.textContent = '';
  for (const item of items) container.appendChild(renderItem(item));
}

function renderItem(item: TranscriptItem): HTMLElement {
  switch (item.kind) {
    case 'user': {
      const node = el('div', 'msg msg-user');
      node.appendChild(el('div', 'msg-role', 'you'));
      node.appendChild(el('div', 'msg-body', item.text));
      return node;
    }
    case 'assistant': {
      const node = el('div', 'msg msg-assistant');
      node.appendChild(el('div', 'msg-role', 'agent'));
      const body = el('div', 'msg-body md-body');
      body.appendChild(renderMarkdown(item.text));
      node.appendChild(body);
      return node;
    }
    case 'thinking': {
      const node = el('details', 'msg msg-thinking');
      node.appendChild(el('summary', 'msg-role', 'thinking'));
      node.appendChild(el('div', 'msg-body', item.text));
      return node;
    }
    case 'error': {
      const node = el('div', 'msg msg-error');
      node.appendChild(el('div', 'msg-role', 'error'));
      node.appendChild(el('div', 'msg-body', item.message));
      return node;
    }
    case 'notice':
      return el('div', 'notice', item.text);
    case 'tool':
      return renderTool(item);
  }
}

function renderTool(item: ToolCallItem): HTMLElement {
  const node = el('details', `tool tool-${item.status}`);
  const summary = el('summary', 'tool-summary');
  summary.appendChild(el('span', `tool-dot tool-dot-${item.status}`, ''));
  summary.appendChild(el('span', 'tool-name', item.name));
  if (item.inputPreview) {
    summary.appendChild(el('span', 'tool-target', truncate(item.inputPreview, 90)));
  }
  node.appendChild(summary);

  const body = el('div', 'tool-body');

  if (item.inputPreview) {
    body.appendChild(el('div', 'tool-label', 'input'));
    body.appendChild(el('pre', 'tool-pre', stripAnsi(item.inputPreview)));
  }

  // The honesty branch: "no output recorded" and "output produced nothing" are
  // different facts and must not render identically.
  if (item.outputUnavailable === true) {
    body.appendChild(
      el(
        'div',
        'tool-unavailable',
        'Result not available after refresh — successful tool output is not persisted to the session ledger.',
      ),
    );
  } else if (item.output !== undefined && item.output !== '') {
    body.appendChild(el('div', 'tool-label', 'output'));
    const clean = stripAnsi(item.output);
    if (clean.length > OUTPUT_PREVIEW_CHARS) {
      const pre = el('pre', 'tool-pre', clean.slice(0, OUTPUT_PREVIEW_CHARS));
      body.appendChild(pre);
      const more = el(
        'button',
        'tool-more',
        `Show full output (${clean.length.toLocaleString()} chars)`,
      );
      more.addEventListener('click', () => {
        pre.textContent = clean;
        more.remove();
      });
      body.appendChild(more);
    } else {
      body.appendChild(el('pre', 'tool-pre', clean));
    }
  }

  if (item.diff !== undefined) {
    body.appendChild(el('div', 'tool-label', 'diff'));
    body.appendChild(el('pre', 'tool-pre', stripAnsi(String(item.diff))));
  }

  node.appendChild(body);
  return node;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** One request from the agent awaiting a human answer. */
export interface PendingApproval {
  id: string;
  sessionId?: string;
  createdAt?: string;
  request: {
    message?: string;
    title?: string;
    description?: string;
    serverName?: string;
    origin?: string;
    type?: 'text' | 'confirm' | 'choice' | 'multi_choice' | 'number';
    choices?: string[];
    questionDefault?: string | boolean | number;
  };
}

/** How the browser answered — mirrors ElicitationResult's action union. */
export type ApprovalAnswer =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' };

/**
 * Render pending approvals as actionable cards.
 *
 * Invariant: a turn BLOCKS on these. The agent is suspended inside a tool call
 * until the bridge resolves, so an approval that renders but cannot be answered
 * hangs the session with no visible cause. Every card therefore always offers a
 * terminal action — the typed inputs are conveniences layered on top of an
 * Approve/Deny pair that is present regardless of request shape.
 */
export function renderApprovals(
  container: HTMLElement,
  pending: PendingApproval[],
  onAnswer: (id: string, answer: ApprovalAnswer) => void,
): void {
  container.textContent = '';
  container.classList.toggle('has-pending', pending.length > 0);

  for (const item of pending) {
    const req = item.request ?? {};
    const card = el('div', 'approval-card');

    const head = el('div', 'approval-head');
    head.appendChild(el('span', 'approval-badge', req.origin === 'agent' ? 'question' : 'approval'));
    if (req.serverName) head.appendChild(el('span', 'approval-source', req.serverName));
    card.appendChild(head);

    const title = req.title ?? req.message ?? 'The agent is waiting for a response.';
    card.appendChild(el('div', 'approval-title', title));
    if (req.description && req.description !== title) {
      card.appendChild(el('div', 'approval-desc', req.description));
    }

    const actions = el('div', 'approval-actions');

    if (req.type === 'choice' && Array.isArray(req.choices) && req.choices.length > 0) {
      for (const choice of req.choices) {
        const btn = el('button', 'approval-btn', choice);
        btn.addEventListener('click', () =>
          onAnswer(item.id, { action: 'accept', content: { value: choice } }),
        );
        actions.appendChild(btn);
      }
    } else if (req.type === 'text' || req.type === 'number') {
      const input = document.createElement('input');
      input.className = 'approval-input';
      input.type = req.type === 'number' ? 'number' : 'text';
      if (req.questionDefault !== undefined) input.value = String(req.questionDefault);
      const submit = (): void =>
        onAnswer(item.id, {
          action: 'accept',
          content: { value: req.type === 'number' ? Number(input.value) : input.value },
        });
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') submit();
      });
      card.appendChild(input);
      const send = el('button', 'approval-btn approval-primary', 'Submit');
      send.addEventListener('click', submit);
      actions.appendChild(send);
    } else {
      const yes = el('button', 'approval-btn approval-primary', 'Approve');
      yes.addEventListener('click', () =>
        onAnswer(item.id, { action: 'accept', content: { value: true } }),
      );
      actions.appendChild(yes);
    }

    // Always present, whatever the request shape — see the invariant above.
    const no = el('button', 'approval-btn approval-danger', 'Deny');
    no.addEventListener('click', () => onAnswer(item.id, { action: 'decline' }));
    actions.appendChild(no);

    card.appendChild(actions);
    container.appendChild(card);
  }
}
