/**
 * Enhanced diff viewer: parses unified diff strings into collapsible hunk
 * sections with line-number gutters, per-line colouring, and add/del stats.
 *
 * Invariant: no innerHTML is used anywhere in this module. All text from the
 * diff string (which may originate from attacker-influenced file content) is
 * placed via textContent only.
 *
 * Design: each hunk is a `<details>` element — collapse/expand is keyboard-
 * accessible with no JS event management. A file-name header is extracted from
 * the `+++ b/path` line when present and shown above the hunks.
 *
 * CSS classes are prefixed `dv-` and defined in diff-viewer.css.
 *
 * @module web-server/frontend/diff-viewer
 */

// ── types ──────────────────────────────────────────────────────────────────

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  content: string;
  /** 1-based old-side line number, absent for addition lines. */
  oldNum?: number;
  /** 1-based new-side line number, absent for deletion lines. */
  newNum?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

// ── constants ──────────────────────────────────────────────────────────────

/** Auto-collapse when total diff lines exceed this threshold. */
const AUTO_COLLAPSE_THRESHOLD = 50;

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

/** Parse `@@ -oldStart[,oldCount] +newStart[,newCount] @@` header. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { oldStart: parseInt(m[1], 10), newStart: parseInt(m[2], 10) };
}

// ── public parser ──────────────────────────────────────────────────────────

/**
 * Parse a unified diff string into an array of {@link DiffHunk}s.
 * Lines before the first `@@` marker (file headers) are skipped.
 * Exported for testability.
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const rawLines = diff.split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      const coords = parseHunkHeader(raw);
      if (coords) {
        current = { header: raw, oldStart: coords.oldStart, newStart: coords.newStart, lines: [] };
        hunks.push(current);
        oldCursor = coords.oldStart;
        newCursor = coords.newStart;
      }
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.lines.push({ type: 'add', content: raw.slice(1), newNum: newCursor++ });
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      current.lines.push({ type: 'del', content: raw.slice(1), oldNum: oldCursor++ });
    } else if (raw.startsWith(' ') || raw === '') {
      current.lines.push({ type: 'ctx', content: raw.startsWith(' ') ? raw.slice(1) : '', oldNum: oldCursor++, newNum: newCursor++ });
    }
    // File-header lines (+++/---) and \\ No newline markers are silently skipped.
  }

  return hunks;
}

// ── private render helpers ─────────────────────────────────────────────────

/** Extract the file path from `+++ b/path` or `+++ path` lines in the raw diff. */
function extractFileName(diff: string): string | undefined {
  const m = /^\+{3}\s+(?:b\/)?(.+)/m.exec(diff);
  return m?.[1]?.trim();
}

/** Build the gutter cell (line number or blank). */
function gutterCell(num: number | undefined): HTMLElement {
  const cell = el('span', 'dv-gutter');
  cell.textContent = num !== undefined ? String(num) : '';
  return cell;
}

/** Render one diff line row: [old-gutter] [new-gutter] [sigil] [content]. */
function buildLineRow(line: DiffLine): HTMLElement {
  const row = el('span', `dv-line dv-line-${line.type}`);
  row.appendChild(gutterCell(line.oldNum));
  row.appendChild(gutterCell(line.newNum));
  const sigil = el('span', 'dv-sigil');
  sigil.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  row.appendChild(sigil);
  const code = el('span', 'dv-content');
  code.textContent = line.content;
  row.appendChild(code);
  return row;
}

/** Count add/del lines and return a `+N / -M` stats string. */
function hunkStats(lines: DiffLine[]): string {
  let adds = 0;
  let dels = 0;
  for (const l of lines) {
    if (l.type === 'add') adds++;
    else if (l.type === 'del') dels++;
  }
  return `+${adds} / -${dels}`;
}

/** Render a single hunk as a collapsible `<details>` element. */
function buildHunkDetails(hunk: DiffHunk, collapsed: boolean): HTMLElement {
  const details = document.createElement('details');
  details.className = 'dv-hunk';
  if (!collapsed) details.setAttribute('open', '');

  const summary = document.createElement('summary');
  summary.className = 'dv-hunk-header';

  const chevron = el('span', 'dv-chevron');
  chevron.textContent = '▶';
  summary.appendChild(chevron);

  const headerText = el('span', 'dv-hunk-range', hunk.header.replace(/^@@\s*/, '').replace(/\s*@@.*$/, ' @@'));
  summary.appendChild(headerText);

  const stats = el('span', 'dv-hunk-stats', hunkStats(hunk.lines));
  summary.appendChild(stats);

  details.appendChild(summary);

  const body = el('div', 'dv-hunk-body');
  for (const line of hunk.lines) {
    body.appendChild(buildLineRow(line));
  }
  details.appendChild(body);

  return details;
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Render a unified diff string as a DOM element with collapsible hunk sections,
 * line-number gutters, and add/del stats.
 *
 * @param diff     - Raw unified diff string (may contain ANSI stripped already).
 * @param opts     - Optional: file name override and initial collapsed state.
 */
export function renderDiffBlock(
  diff: string,
  opts?: { fileName?: string; collapsed?: boolean },
): HTMLElement {
  const hunks = parseDiffHunks(diff);

  const totalLines = hunks.reduce((n, h) => n + h.lines.length, 0);
  const collapsed = opts?.collapsed ?? totalLines > AUTO_COLLAPSE_THRESHOLD;

  const root = el('div', 'dv-root');

  // File name header
  const fileName = opts?.fileName ?? extractFileName(diff);
  if (fileName) {
    const fileHeader = el('div', 'dv-file-header');
    const icon = el('span', 'dv-file-icon');
    icon.textContent = '📄';
    fileHeader.appendChild(icon);
    fileHeader.appendChild(el('span', 'dv-file-name', fileName));
    root.appendChild(fileHeader);
  }

  if (hunks.length === 0) {
    root.appendChild(el('div', 'dv-empty', '(no changes)'));
    return root;
  }

  for (const hunk of hunks) {
    root.appendChild(buildHunkDetails(hunk, collapsed));
  }

  return root;
}
