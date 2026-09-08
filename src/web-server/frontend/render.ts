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
import { applyIncrementalUpdate } from './render-incremental.js';
import { createThinkingBlockNode } from './thinking-panel.js';
import { classifySession, renderStatusBadge } from './session-status.js';
import { renderDiffBlock } from './diff-viewer.js';
export type { PendingApproval, ApprovalAnswer } from './render-approvals.js';
export { renderApprovals } from './render-approvals.js';

/** Beyond this, tool output is collapsed behind a "show full" control. */
const OUTPUT_PREVIEW_CHARS = 2_000;
/** Beyond this, tool input is collapsed behind a "show full input" control. */
const INPUT_PREVIEW_CHARS = 2_000;

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
  const b = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '';
  return b && b !== '.' ? b : undefined;
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

  // Sort: alive/running sessions first, then the rest in original order.
  const sorted = [
    ...sessions.filter((s) => s.alive === true || s.mode === 'live'),
    ...sessions.filter((s) => !(s.alive === true || s.mode === 'live')),
  ];

  for (const s of sorted) {
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
    if (dir) {
      const cwdEl = el('span', 'session-cwd', dir);
      cwdEl.title = s.cwd ?? dir;
      meta.appendChild(cwdEl);
    }
    // A readonly session lives in another OS process; its approvals are
    // unreachable from here. The badge is the user-facing half of that
    // contract — the composer is disabled to match.
    const badge = el('span', s.mode === 'live' ? 'badge badge-live' : 'badge badge-readonly');
    badge.textContent = s.mode === 'live' ? 'live' : 'read-only';
    meta.appendChild(badge);
    // Status badge: needs-input proxy for alive+live sessions.
    if (s.alive === true && s.mode === 'live') {
      meta.appendChild(renderStatusBadge('needs-input'));
    } else {
      meta.appendChild(renderStatusBadge(classifySession(s)));
    }
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

/**
 * Incrementally update the transcript container.
 *
 * Delegates to `applyIncrementalUpdate` in render-incremental.ts.
 * Steady-state cost: O(new items). Full rebuild only on session switch/reset.
 * Scroll-pinning: caller samples `isPinnedToBottom` before and scrolls after.
 */
export function renderTranscript(container: HTMLElement, items: TranscriptItem[]): void {
  applyIncrementalUpdate(container, items, renderItem);
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
    case 'thinking':
      return createThinkingBlockNode(item);
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
    summary.appendChild(el('span', 'tool-target', summarizeToolInput(item.name, item.inputPreview)));
  }
  node.appendChild(summary);

  const body = el('div', 'tool-body');

  if (item.inputPreview) {
    body.appendChild(el('div', 'tool-label', 'input'));
    const cleanInput = stripAnsi(item.inputPreview);
    if (cleanInput.length > INPUT_PREVIEW_CHARS) {
      const inputPre = el('pre', 'tool-pre', cleanInput.slice(0, INPUT_PREVIEW_CHARS));
      body.appendChild(inputPre);
      const moreInput = el(
        'button',
        'tool-more',
        `Show full input (${cleanInput.length.toLocaleString()} chars)`,
      );
      moreInput.addEventListener('click', () => {
        inputPre.textContent = cleanInput;
        moreInput.remove();
      });
      body.appendChild(moreInput);
    } else {
      body.appendChild(el('pre', 'tool-pre', cleanInput));
    }
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
    body.appendChild(renderDiffBlock(stripAnsi(String(item.diff))));
  }

  node.appendChild(body);
  return node;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}


/** Semantic one-liner for the tool summary row. */
function summarizeToolInput(name: string, preview: string): string {
  try {
    const j = JSON.parse(preview) as Record<string, unknown>;
    if ((name === 'bash' || name === 'shell') && typeof j['command'] === 'string')
      return truncate(j['command'] as string, 80);
    if ((name === 'edit_file' || name === 'write_file' || name === 'read_file') && typeof j['file_path'] === 'string')
      return j['file_path'] as string;
    if (name === 'agent' && typeof j['prompt'] === 'string')
      return truncate(j['prompt'] as string, 60);
    if ((name === 'grep' || name === 'glob') && typeof j['pattern'] === 'string')
      return j['pattern'] as string;
  } catch { /* fall through */ }
  return truncate(preview, 90);
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
