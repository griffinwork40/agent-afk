import stringWidth from 'string-width';

// Matches, in priority order:
//   1. CSI:  ESC [ … final-byte (e.g. SGR `\x1b[31m`)
//   2. OSC:  ESC ] … terminated by BEL (`\x07`) or ST (`\x1b\\`)
//            — covers OSC 8 hyperlinks, iTerm2 image protocol, title sets, etc.
//   3. DCS/PM/APC/SOS: ESC [P^_X] … terminated by ST (`\x1b\\`)
//   4. Bare 2-byte: ESC + a single byte in the original class
//      `[@-Z\\-_]` MINUS the multi-byte openers P/X/_ that now have
//      structured branches above. The resulting class is
//      `[@-OQ-WYZ\\-]` (0x2D, 0x40–0x4F, 0x51–0x57, 0x59–0x5A, 0x5C).
//
// Without the OSC/DCS branches, file content containing e.g.
// `\x1b]8;;http://x\x07` would pass through stripAnsi entirely (the
// previous regex did not match `ESC]`), letting BEL / title-set / inline-
// image escapes reach the terminal verbatim from adversarial diff content.
const ANSI_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[P^_X][^\x1B]*\x1B\\|[@-OQ-WYZ\\\-])/g;
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

interface TextToken {
  type: 'text';
  value: string;
}

interface AnsiToken {
  type: 'ansi';
  value: string;
}

type DisplayToken = TextToken | AnsiToken;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function splitGraphemes(text: string): string[] {
  if (text.length === 0) return [];
  if (segmenter) {
    return Array.from(segmenter.segment(text), (entry) => entry.segment);
  }
  return Array.from(text);
}

function tokenizeAnsi(text: string): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  ANSI_RE.lastIndex = 0;
  while ((match = ANSI_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      for (const grapheme of splitGraphemes(text.slice(lastIndex, match.index))) {
        tokens.push({ type: 'text', value: grapheme });
      }
    }
    tokens.push({ type: 'ansi', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    for (const grapheme of splitGraphemes(text.slice(lastIndex))) {
      tokens.push({ type: 'text', value: grapheme });
    }
  }
  return tokens;
}

export function padDisplayRight(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text));
  return text + ' '.repeat(pad);
}

export function padDisplayLeft(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text));
  return ' '.repeat(pad) + text;
}

export function padDisplay(
  text: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left',
): string {
  const pad = Math.max(0, width - displayWidth(text));
  if (pad === 0) return text;
  if (align === 'right') return padDisplayLeft(text, width);
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
  }
  return padDisplayRight(text, width);
}

// OSC 8 hyperlink tokens: `ESC ] 8 ; params ; URI (BEL|ST)`. An OPEN has a
// non-empty URI; a CLOSE has an empty one (`ESC ]8;;ST`). Truncation must
// track open/close state — see truncateDisplayWidth below.
const OSC8_TOKEN_RE = /^\x1b\]8;[^;\x07\x1b]*;(.*?)(?:\x07|\x1b\\)$/s;

/** OSC 8 close sequence (ST-terminated) — ends the current hyperlink span. */
const OSC8_CLOSE = '\x1b]8;;\x1b\\';

export function truncateDisplayWidth(
  text: string,
  maxWidth: number,
  ellipsis: string = '…',
): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;

  const ellipsisWidth = displayWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisWidth);
  let width = 0;
  let out = '';
  let sawAnsi = false;
  let openHyperlink = false;

  for (const token of tokenizeAnsi(text)) {
    if (token.type === 'ansi') {
      out += token.value;
      sawAnsi = true;
      // Track OSC 8 open/close state: if the truncation cut lands between a
      // hyperlink's open and close sequences, the dropped close would leave
      // the link span unterminated and everything rendered AFTER this string
      // (padding, the next lane row, …) would become part of the link
      // ("link bleed"). The trailing `\x1b[0m` SGR reset does NOT close an
      // OSC 8 span — only `ESC ]8;;ST` does — so we re-close explicitly.
      const osc8 = OSC8_TOKEN_RE.exec(token.value);
      if (osc8) openHyperlink = (osc8[1] ?? '').length > 0;
      continue;
    }
    const nextWidth = width + displayWidth(token.value);
    if (nextWidth > budget) break;
    out += token.value;
    width = nextWidth;
  }

  // Ellipsis goes INSIDE a still-open link span so the truncated remnant
  // stays clickable end-to-end, then the span is closed before the reset.
  return out + ellipsis + (openHyperlink ? OSC8_CLOSE : '') + (sawAnsi ? '\x1b[0m' : '');
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

export function previousGraphemeIndex(text: string, index: number): number {
  const target = clampIndex(index, text.length);
  if (target === 0 || text.length === 0) return 0;

  let prev = 0;
  for (const grapheme of splitGraphemes(text)) {
    const next = prev + grapheme.length;
    if (next >= target) return prev;
    prev = next;
  }
  return prev;
}

export function nextGraphemeIndex(text: string, index: number): number {
  const target = clampIndex(index, text.length);
  if (target >= text.length || text.length === 0) return text.length;

  let offset = 0;
  for (const grapheme of splitGraphemes(text)) {
    const next = offset + grapheme.length;
    if (offset >= target) return next;
    if (target > offset && target < next) return next;
    offset = next;
  }
  return text.length;
}

function rowsUsed(lineWidth: number, startCol: number, columns: number): number {
  if (columns <= 0) return 1;
  if (lineWidth <= 0) return 1;
  return Math.floor((startCol + lineWidth - 1) / columns) + 1;
}

export interface CursorMetrics {
  row: number;
  col: number;
}

export interface BufferMetrics {
  cursor: CursorMetrics;
  end: CursorMetrics;
  rowsUsed: number;
}

export function measureBuffer(
  buffer: string,
  cursor: number,
  promptWidth: number,
  columns: number,
): BufferMetrics {
  const width = columns > 0 ? columns : 80;
  const safeCursor = clampIndex(cursor, buffer.length);
  const beforeCursor = buffer.slice(0, safeCursor).split('\n');
  const lines = buffer.split('\n');
  const cursorLineIndex = beforeCursor.length - 1;

  let totalRows = 0;
  let endRow = 0;
  let endCol = 0;
  let cursorRow = 0;
  let cursorCol = 0;

  for (let i = 0; i < lines.length; i++) {
    const startCol = i === 0 ? promptWidth : 0;
    const fullLineWidth = displayWidth(lines[i] ?? '');
    const lineRows = rowsUsed(fullLineWidth, startCol, width);
    const lineEndOffset = startCol + fullLineWidth;
    endRow = totalRows + Math.floor(lineEndOffset / width);
    endCol = lineEndOffset % width;

    if (i === cursorLineIndex) {
      const cursorLineWidth = displayWidth(beforeCursor[i] ?? '');
      const cursorOffset = startCol + cursorLineWidth;
      cursorRow = totalRows + Math.floor(cursorOffset / width);
      cursorCol = cursorOffset % width;
    }

    totalRows += lineRows;
  }

  return {
    cursor: { row: cursorRow, col: cursorCol },
    end: { row: endRow, col: endCol },
    rowsUsed: totalRows,
  };
}
