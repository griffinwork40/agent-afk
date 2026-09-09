/**
 * Tool-call trace panel: renders a {@link ToolCallItem} as a collapsible card.
 *
 * Invariant: NOTHING here uses innerHTML with model- or server-derived text.
 * Every value sourced from an agent, tool, or file path is placed with
 * textContent. Tool output is attacker-influencable so treating it as markup
 * would be a stored-XSS hole in a page that holds a live bearer token.
 *
 * Design: each card is a `<details>` element so collapse/expand is keyboard-
 * accessible and requires no JS event management. Cards are collapsed by
 * default (no `open` attribute). The header (`<summary>`) shows: status badge,
 * tool name, and a one-line input preview. The body (inside `<details>`) shows
 * the full input, output (or unavailability note), duration, and diff.
 *
 * CSS classes added by this module are prefixed with `tc-` to distinguish them
 * from the existing `tool-` classes in render.ts. They are defined in
 * styles.css at the bottom of the tool-calls section.
 *
 * @module web-server/frontend/tool-trace-panel
 */

import { stripAnsi } from './ansi-strip.js';
import type { ToolCallItem } from './view-model.js';
import type { DiffPayload, DiffHunk, DiffLine } from '../../utils/diff.js';

// ── constants ──────────────────────────────────────────────────────────────

/** Characters shown in the inline input preview on the collapsed header. */
const HEADER_PREVIEW_CHARS = 80;
/** Characters shown in the expanded input/output before a "show more" button. */
const BODY_PREVIEW_CHARS = 2_000;

// ── helpers ────────────────────────────────────────────────────────────────

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

function truncateLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/** Build a truncated `<pre>` with an optional "Show full (N chars)" button. */
function buildPreviewPre(raw: string, limit: number, className: string): HTMLElement {
  const clean = stripAnsi(raw);
  const frag = el('div', 'tc-pre-wrap');
  const pre = el('pre', className, clean.slice(0, limit));
  frag.appendChild(pre);
  if (clean.length > limit) {
    const more = el(
      'button',
      'tool-more',
      `Show full (${clean.length.toLocaleString()} chars)`,
    );
    more.addEventListener('click', () => {
      pre.textContent = clean;
      more.remove();
    });
    frag.appendChild(more);
  }
  return frag;
}

/** Render a {@link DiffPayload} into a `<pre>` with per-line coloured spans. */
function renderDiffPayload(diff: DiffPayload): HTMLPreElement {
  const pre = el('pre', 'tool-pre tool-diff');
  for (const hunk of diff.hunks) {
    renderHunk(pre, hunk);
  }
  if (diff.hunks.length === 0) {
    const span = document.createElement('span');
    span.className = 'diff-ctx';
    span.textContent = '(no changes)';
    pre.appendChild(span);
  }
  return pre;
}

function diffLineClass(line: DiffLine): string {
  if (line.kind === '+') return 'diff-add';
  if (line.kind === '-') return 'diff-del';
  return 'diff-ctx';
}

function renderHunk(pre: HTMLPreElement, hunk: DiffHunk): void {
  // Hunk header line
  const header = document.createElement('span');
  header.className = 'diff-hunk';
  const filePrefix = hunk.filePath ? ` ${hunk.filePath}` : '';
  header.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${filePrefix}`;
  pre.appendChild(header);
  // Hunk lines
  for (const line of hunk.lines) {
    const span = document.createElement('span');
    span.textContent = line.text;
    span.className = diffLineClass(line);
    pre.appendChild(span);
  }
}

/** Format milliseconds as a human-readable duration string. */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1_000).toFixed(0);
  return `${m}m ${s}s`;
}

// ── status badge ───────────────────────────────────────────────────────────

/**
 * Builds the status badge element for the card header.
 *
 * running → yellow pulsing dot (matches existing .tool-dot-running)
 * ok      → green dot
 * error   → red dot
 */
function buildStatusBadge(item: ToolCallItem): HTMLElement {
  const wrap = el('span', 'tc-status');
  const dot = el('span', `tc-dot tool-dot-${item.status}`);
  wrap.appendChild(dot);
  const label = el('span', `tc-status-label tc-status-${item.status}`);
  label.textContent =
    item.status === 'running' ? 'running' : item.status === 'ok' ? 'ok' : 'error';
  wrap.appendChild(label);
  return wrap;
}

// ── card body sections ──────────────────────────────────────────────────────

function buildInputSection(inputPreview: string): HTMLElement {
  const section = el('div', 'tc-section');
  section.appendChild(el('div', 'tool-label', 'input'));
  section.appendChild(buildPreviewPre(inputPreview, BODY_PREVIEW_CHARS, 'tool-pre'));
  return section;
}

function buildOutputSection(item: ToolCallItem): HTMLElement | null {
  if (item.outputUnavailable === true) {
    const note = el('div', 'tc-unavailable');
    note.textContent = '(output not available)';
    return note;
  }
  if (item.output === undefined || item.output === '') return null;
  const section = el('div', 'tc-section');
  section.appendChild(el('div', 'tool-label', 'output'));
  section.appendChild(buildPreviewPre(item.output, BODY_PREVIEW_CHARS, 'tool-pre'));
  return section;
}

function buildDiffSection(diff: DiffPayload): HTMLElement {
  const section = el('div', 'tc-section');
  section.appendChild(el('div', 'tool-label', 'diff'));
  section.appendChild(renderDiffPayload(diff));
  return section;
}

function buildDurationRow(ms: number): HTMLElement {
  const row = el('div', 'tc-meta-row');
  row.appendChild(el('span', 'tc-meta-label', 'duration'));
  row.appendChild(el('span', 'tc-meta-value', formatDuration(ms)));
  return row;
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Render a {@link ToolCallItem} as a collapsible card and append it to
 * `container`. The card is collapsed by default; clicking the header expands
 * it to reveal input, output, duration, and diff.
 *
 * Contract: this function is ADDITIVE — it appends one `<details>` node to
 * `container`. Callers own the container and are responsible for clearing it
 * between full redraws.
 */
export function renderToolCallCard(item: ToolCallItem, container: HTMLElement): void {
  const card = el('details', 'tc-card');
  // collapsed by default: no `open` attribute

  // ── header (summary) ────────────────────────────────────────────────────
  const summary = el('summary', 'tc-header');

  // chevron is provided by CSS ::before on summary, matching render.ts pattern
  summary.appendChild(buildStatusBadge(item));

  const nameEl = el('span', 'tc-name');
  nameEl.textContent = item.name;
  summary.appendChild(nameEl);

  if (item.inputPreview) {
    const preview = el('span', 'tc-input-preview');
    preview.textContent = truncateLine(item.inputPreview, HEADER_PREVIEW_CHARS);
    summary.appendChild(preview);
  }

  if (item.durationMs !== undefined) {
    const dur = el('span', 'tc-header-duration');
    dur.textContent = formatDuration(item.durationMs);
    summary.appendChild(dur);
  }

  card.appendChild(summary);

  // ── body ────────────────────────────────────────────────────────────────
  const body = el('div', 'tc-body');

  if (item.durationMs !== undefined) {
    body.appendChild(buildDurationRow(item.durationMs));
  }

  if (item.inputPreview) {
    body.appendChild(buildInputSection(item.inputPreview));
  }

  const outputSection = buildOutputSection(item);
  if (outputSection) {
    body.appendChild(outputSection);
  }

  if (item.diff !== undefined) {
    body.appendChild(buildDiffSection(item.diff));
  }

  card.appendChild(body);
  container.appendChild(card);
}
