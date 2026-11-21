/**
 * Pure renderer for the global chat view: state + terminal size in, the exact
 * lines to paint out. No I/O.
 *
 * Contract: every returned line has display width <= columns (a final
 * `truncateDisplayWidth` clamp backs up the layout math), and the array has
 * exactly `rows` entries so the view can paint row by row.
 *
 * @module cli/commands/interactive/global-chat-render
 */

import type { ChalkInstance } from 'chalk';
import { palette } from '../../palette.js';
import { displayWidth, splitGraphemes, suffixDisplayWidth, truncateDisplayWidth } from '../../display.js';
import { MAX_TEXT_CHARS, ROOM } from '../../../global-chat/protocol.js';
import type { ChatEntry, ChatMessageEntry, ChatViewState } from './global-chat-model.js';

export const MIN_COLUMNS = 20;
export const MIN_ROWS = 6;
/** The live character counter appears once the input reaches this many characters. */
export const COUNTER_FROM = MAX_TEXT_CHARS - 100;

const AUTHOR_COLORS: readonly ChalkInstance[] = [
  palette.brand, palette.mint, palette.shell, palette.goblin, palette.caret, palette.plan,
];

export interface ChatFrame { lines: string[]; maxScroll: number }

export function authorColor(pubkey: string, isMe: boolean): ChalkInstance {
  if (isMe) return palette.user;
  const n = Number.parseInt(pubkey.slice(0, 2), 16);
  return AUTHOR_COLORS[(Number.isFinite(n) ? n : 0) % AUTHOR_COLORS.length] ?? palette.brand;
}

/** Grapheme runs of `text` wrapped to `width` columns; each grapheme keeps its flag. */
function wrapFlagged(cells: Array<{ g: string; hi: boolean }>, firstWidth: number, width: number): Array<typeof cells> {
  const out: Array<typeof cells> = [];
  let line: typeof cells = [];
  let used = 0;
  let limit = Math.max(1, firstWidth);
  for (const cell of cells) {
    const w = displayWidth(cell.g);
    if (used + w > limit && line.length > 0) {
      out.push(line);
      line = [];
      used = 0;
      limit = Math.max(1, width);
    }
    if (w > limit) continue; // a wide grapheme in a 1-column box cannot be shown
    line.push(cell);
    used += w;
  }
  if (line.length > 0 || out.length === 0) out.push(line);
  return out;
}

function styleRun(cells: Array<{ g: string; hi: boolean }>, base: (s: string) => string): string {
  let out = '';
  let i = 0;
  while (i < cells.length) {
    const hi = cells[i]?.hi ?? false;
    let run = '';
    while (i < cells.length && (cells[i]?.hi ?? false) === hi) { run += cells[i]?.g ?? ''; i++; }
    out += hi ? palette.warning(palette.bold(run)) : base(run);
  }
  return out;
}

/** Marks graphemes that belong to an `@name` mention of the current user. */
export function mentionCells(text: string, myName: string | null): Array<{ g: string; hi: boolean }> {
  const graphemes = splitGraphemes(text);
  const cells = graphemes.map((g) => ({ g, hi: false }));
  if (!myName) return cells;
  const needle = `@${myName}`;
  const re = new RegExp(`(^|[^a-z0-9_-])(${needle.replace(/[-]/g, '\\-')})(?![a-z0-9_-])`, 'gi');
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(re)) {
    const start = m.index + (m[1]?.length ?? 0);
    ranges.push([start, start + needle.length]);
  }
  let offset = 0;
  for (const cell of cells) {
    const end = offset + cell.g.length;
    if (ranges.some(([a, b]) => offset < b && end > a)) cell.hi = true;
    offset = end;
  }
  return cells;
}

function layoutMessage(e: ChatMessageEntry, state: ChatViewState, cols: number, nWidth: number): string[] {
  const isMe = state.me?.pubkey === e.pubkey;
  const color = authorColor(e.pubkey, isMe);
  const num = String(e.n);
  const numCol = ' '.repeat(Math.max(0, nWidth - num.length)) + num;
  const author = `${e.name}#${e.tag}`;
  const badge = e.badge === 'maintainer' ? ' [maint]' : '';
  const prefixPlain = `${numCol} ${author}${badge} `;
  const prefix = `${palette.dim(numCol)} ${color(isMe ? palette.bold(author) : author)}${badge ? palette.info(badge) : ''} `;
  const indent = Math.min(nWidth + 1, Math.floor(cols / 2));
  const firstWidth = cols - displayWidth(prefixPlain);
  const cells = mentionCells(e.text, isMe ? null : state.me?.name ?? null);
  const base = (s: string): string => (isMe ? palette.user(s) : s);
  if (firstWidth < 4) {
    const rows = wrapFlagged(cells, cols - indent, cols - indent);
    return [truncateDisplayWidth(prefix, cols), ...rows.map((r) => ' '.repeat(indent) + styleRun(r, base))];
  }
  const rows = wrapFlagged(cells, firstWidth, cols - indent);
  return rows.map((r, i) => (i === 0 ? prefix : ' '.repeat(indent)) + styleRun(r, base));
}

function layoutEntry(e: ChatEntry, state: ChatViewState, cols: number, nWidth: number): string[] {
  if (e.kind === 'msg') return layoutMessage(e, state, cols, nWidth);
  const mark = e.level === 'error' ? '! ' : '* ';
  const style = e.level === 'error' ? palette.error : palette.dim;
  const rows = wrapFlagged(splitGraphemes(mark + e.text).map((g) => ({ g, hi: false })), cols, cols - 2);
  return rows.map((r, i) => (i === 0 ? '' : '  ') + style(r.map((c) => c.g).join('')));
}

function headerLine(state: ChatViewState): string {
  const parts = [palette.heading(`#${ROOM}`)];
  if (state.online !== null) parts.push(`${state.online} online`);
  const statusStyle = state.status === 'open' ? palette.success : state.status === 'closed' ? palette.error : palette.warning;
  parts.push(statusStyle(state.status === 'open' ? 'connected' : state.status));
  if (state.mode !== 'open') parts.push(palette.warning(state.mode === 'readonly' ? 'read-only' : 'closed'));
  if (state.me) parts.push(palette.dim(`you: ${state.me.name}#${state.me.tag}`));
  return parts.join(palette.dim(' | '));
}

export function inputLine(state: ChatViewState, cols: number): string {
  const count = Array.from(state.input).length;
  const counter = count >= COUNTER_FROM ? ` ${count}/${MAX_TEXT_CHARS}` : '';
  const counterStyled = count > MAX_TEXT_CHARS ? palette.error(counter) : palette.dim(counter);
  const room = Math.max(0, cols - 2 - displayWidth(counter));
  if (state.sending) return palette.dim('> ') + palette.dim(truncateDisplayWidth(`sending: ${state.input}`, room)) + counterStyled;
  return palette.dim('> ') + suffixDisplayWidth(state.input, room) + counterStyled;
}

const HINT = 'Enter send | PgUp/PgDn scroll | /help | Esc leave';

function tinyFrame(state: ChatViewState, cols: number, rows: number): ChatFrame {
  const lines: string[] = [];
  if (rows >= 2) lines.push(palette.dim('enlarge window'));
  while (lines.length < rows - 1) lines.push('');
  if (rows >= 1) lines.push(inputLine(state, cols));
  return { lines: lines.map((l) => truncateDisplayWidth(l, cols)), maxScroll: 0 };
}

/**
 * Lay out the whole screen. `maxScroll` lets the view clamp `state.scroll`.
 * While scrolled up (`frozenSeq` set), entries newer than `frozenSeq` sit below
 * the viewport, so arrivals never move what the reader is looking at.
 */
export function renderChat(state: ChatViewState, columns: number, rows: number): ChatFrame {
  const cols = Math.max(0, Math.floor(columns));
  const height = Math.max(0, Math.floor(rows));
  if (cols < MIN_COLUMNS || height < MIN_ROWS) return tinyFrame(state, cols, height);
  const top = [headerLine(state)];
  if (state.banner) top.push(palette.warning(state.banner));
  const area = height - top.length - 2;
  const visible = state.entries.filter((e) => e.kind !== 'msg' || !state.muted.has(e.pubkey));
  const maxN = visible.reduce((m, e) => (e.kind === 'msg' ? Math.max(m, e.n) : m), 0);
  const nWidth = Math.min(4, String(Math.max(1, maxN)).length);
  const body: string[] = [];
  let below = 0;
  for (const e of visible) {
    const lines = layoutEntry(e, state, cols, nWidth);
    body.push(...lines);
    if (state.frozenSeq !== null && e.seq > state.frozenSeq) below += lines.length;
  }
  const anchored = body.length - below;
  const maxScroll = Math.max(0, anchored - area);
  const scroll = Math.min(state.scroll, maxScroll);
  const end = anchored - scroll;
  const windowLines = body.slice(Math.max(0, end - area), end);
  while (windowLines.length < area) windowLines.unshift('');
  if (state.unseen && area > 0) windowLines[area - 1] = palette.info('-- new messages below (PgDn) --');
  const lines = [...top, ...windowLines, palette.dim(HINT), inputLine(state, cols)];
  return { lines: lines.map((l) => truncateDisplayWidth(l, cols)), maxScroll };
}
