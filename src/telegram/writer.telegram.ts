/**
 * Telegram Writer: buffers slash-command text and structured blocks, then
 * renders them to Telegram HTML (parse_mode: 'HTML') split under the 4096-char
 * message limit without ever cutting inside a tag or an HTML entity.
 *
 * Contract: every unit is rendered from RAW text at split time, so a chunk
 * boundary always falls between whole lines (or between raw characters of an
 * over-long line) and each chunk re-opens/closes its own wrapper tag.
 */
import { stripVTControlCharacters } from 'node:util';
import { createConsoleWriter, type WriterSink } from '../cli/slash/writer.js';
import type { Writer } from '../cli/slash/types.js';
import type { OutputBlock } from '../cli/slash/output-blocks.js';

export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Escape &, <, > and " for Telegram HTML. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

type LineFormat = (raw: string) => string;
/** A renderable unit: raw lines, a per-line formatter, and an optional wrapper. */
interface Unit { lines: string[]; fmt: LineFormat; open: string; close: string }

const plain: LineFormat = (raw) => escapeTelegramHtml(raw);
const clean = (s: string): string => stripVTControlCharacters(s);

function textUnit(text: string): Unit {
  const lines = clean(text).replace(/\n$/, '').split('\n');
  return { lines, fmt: plain, open: '', close: '' };
}

function preUnit(lines: string[]): Unit {
  return { lines, fmt: plain, open: '<pre>', close: '</pre>' };
}

function titleUnit(title: string | undefined): Unit[] {
  return title ? [{ lines: [clean(title)], fmt: (r) => `<b>${escapeTelegramHtml(r)}</b>`, open: '', close: '' }] : [];
}

function tableLines(columns: string[], rows: string[][]): string[] {
  const cells = [columns, ...rows].map((row) => row.map((c) => clean(c)));
  const widths = columns.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const fmtRow = (row: string[]): string => widths.map((w, i) => (row[i] ?? '').padEnd(w)).join('  ').trimEnd();
  const [head, ...body] = cells;
  return [fmtRow(head ?? []), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(fmtRow)];
}

/** Map one structured block to renderable units. Unknown kinds use the plain fallback. */
export function blockUnits(block: OutputBlock): Unit[] {
  switch (block.kind) {
    case 'table':
      return [...titleUnit(block.title), preUnit(tableLines(block.columns, block.rows))];
    case 'keyValue': {
      const kv: Unit = {
        lines: block.entries.map((e) => `${clean(e.key)}\u0000${clean(e.value)}`),
        fmt: (raw) => {
          const [k = '', v = ''] = raw.split('\u0000');
          return `<b>${escapeTelegramHtml(k)}</b>: ${escapeTelegramHtml(v)}`;
        },
        open: '', close: '',
      };
      return [...titleUnit(block.title), kv];
    }
    case 'diff':
      return [...titleUnit(block.fileName), preUnit(clean(block.diff).replace(/\n$/, '').split('\n'))];
    case 'list': {
      const items: Unit = {
        lines: block.items.map((i) => `${clean(i.text)}\u0000${clean(i.description ?? '')}`),
        fmt: (raw) => {
          const [t = '', d = ''] = raw.split('\u0000');
          return `• <code>${escapeTelegramHtml(t)}</code>${d ? ` — ${escapeTelegramHtml(d)}` : ''}`;
        },
        open: '', close: '',
      };
      return [...titleUnit(block.title), items];
    }
    case 'link': {
      const url = clean(block.url);
      const safe = /^https?:\/\//i.test(url);
      const label = clean(block.label);
      return [{
        lines: [label],
        fmt: (r) => safe ? `<a href="${escapeTelegramHtml(url)}">${escapeTelegramHtml(r)}</a>` : escapeTelegramHtml(`${r} (${url})`),
        open: '', close: '',
      }];
    }
    default:
      return [textUnit(block.text)];
  }
}

/** Split a raw line so each piece's formatted length fits `budget`. */
function splitRawLine(raw: string, fmt: LineFormat, budget: number): string[] {
  const pieces: string[] = [];
  let rest = raw;
  while (rest.length > 0) {
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fmt(rest.slice(0, mid)).length <= budget) lo = mid; else hi = mid - 1;
    }
    pieces.push(rest.slice(0, lo));
    rest = rest.slice(lo);
  }
  return pieces;
}

/** Pack units into HTML chunks of at most `limit` characters. */
export function renderUnits(units: Unit[], limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let cur = '';
  const push = (): void => { if (cur.trim() !== '') chunks.push(cur.replace(/\n+$/, '')); cur = ''; };
  for (const unit of units) {
    const wrap = unit.open.length + unit.close.length;
    let open = false;
    const closeIfOpen = (): void => { if (open) { cur += unit.close + '\n'; open = false; } };
    for (const raw of unit.lines) {
      const budget = limit - wrap - 1;
      for (const piece of unit.fmt(raw).length > budget ? splitRawLine(raw, unit.fmt, budget) : [raw]) {
        const html = unit.fmt(piece);
        const need = (open ? 0 : unit.open.length) + html.length + 1 + unit.close.length;
        if (cur.length + need > limit) { closeIfOpen(); push(); }
        if (!open) { cur += unit.open; open = true; }
        cur += html + '\n';
      }
    }
    if (open && unit.close) cur = cur.replace(/\n$/, '') + unit.close + '\n';
    open = false;
  }
  push();
  return chunks;
}

/** Buffering Writer whose output renders as Telegram HTML chunks. */
export class TelegramWriter implements WriterSink {
  private readonly entries: Array<string | OutputBlock> = [];

  fn(line: string): void { this.entries.push(line + '\n'); }
  rawFn(text: string): void { this.entries.push(text); }
  block(block: OutputBlock): void { this.entries.push(structuredClone(block)); }

  asWriterInterface(): Writer {
    return { ...createConsoleWriter(this), block: (b) => this.block(b) };
  }

  isEmpty(): boolean {
    return this.entries.every((e) => typeof e === 'string' ? clean(e).trim() === '' : false);
  }

  /** Render buffered output, collapsing adjacent text writes into one unit. */
  toHtmlChunks(limit = TELEGRAM_MESSAGE_LIMIT): string[] {
    const units: Unit[] = [];
    let text = '';
    const flush = (): void => {
      const trimmed = text.replace(/^\n+/, '');
      if (clean(trimmed).trim() !== '') units.push(textUnit(trimmed));
      text = '';
    };
    for (const e of this.entries) {
      if (typeof e === 'string') text += e;
      else { flush(); units.push(...blockUnits(e)); }
    }
    flush();
    return renderUnits(units, limit);
  }
}
