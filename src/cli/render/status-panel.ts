import { displayWidth, padDisplayRight } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';
import { maxInnerBoxWidth, truncateDisplay } from './utils.js';

// ─── Status Panel ─────────────────────────────────────────────────────────────

/** Indicator kind controls the coloured dot shown next to a value. */
export type StatusKind = 'ok' | 'warn' | 'error' | 'info';

const DOT: Record<StatusKind, string> = {
  ok:    palette.success('●'),
  warn:  palette.warning('●'),
  error: palette.error('●'),
  info:  palette.info('◆'),
};

/** A single row inside a status panel. */
export interface StatusRow {
  /** Left-column label (e.g. "SDK", "API Key"). */
  label: string;
  /** Right-column value text. */
  value: string;
  /** Optional coloured dot to prefix the value. */
  kind?: StatusKind;
}

/**
 * Render a framed status panel with aligned key-value rows.
 *
 * Example output (no ANSI):
 * ```
 * ╭──────────────────────────────────────────────────╮
 * │  Agent AFK · Status                            │
 * ├──────────────────────────────────────────────────┤
 * │  SDK           ●  Connected                      │
 * │  API Key       ●  Found (ANTHROPIC_API_KEY)       │
 * │  Model         ◆  sonnet                         │
 * ╰──────────────────────────────────────────────────╯
 * ```
 *
 * @param title - Heading shown inside the panel border.
 * @param rows  - Status rows to display.
 */
export function statusPanel(title: string, rows: StatusRow[]): string {
  const LABEL_GAP = 4; // spaces between label and indicator columns
  const DOT_W    = 2; // one dot character + one trailing space

  const maxLabel = rows.reduce((m, r) => Math.max(m, displayWidth(r.label)), 0);
  const maxValue = rows.reduce((m, r) => Math.max(m, displayWidth(r.value)), 0);

  // Content width = label column + gap + dot+space + value column
  const contentW = maxLabel + LABEL_GAP + DOT_W + maxValue;
  const termStretch = Math.min(getTerminalWidth() - 4, 100);
  let innerW = Math.max(44, displayWidth(title), contentW, termStretch);
  innerW = Math.min(innerW, maxInnerBoxWidth());

  // Each box line: '│' + '  ' + <innerW chars> + '  ' + '│'
  // Horizontal bar fills innerW + 4 dashes so total width equals innerW + 6.
  const barLen = innerW + 4;
  const b = palette.dim; // shorthand

  const top = b('╭' + '─'.repeat(barLen) + '╮');
  const sep = b('├' + '─'.repeat(barLen) + '┤');
  const bot = b('╰' + '─'.repeat(barLen) + '╯');
  const pipe = b('│');

  const titleLines = wrapToWidth(title, innerW).split('\n');
  const headerLines = titleLines.map(
    (tl) => pipe + '  ' + padDisplayRight(tl, innerW) + '  ' + pipe,
  );

  const valColW = Math.max(1, innerW - maxLabel - LABEL_GAP - DOT_W);

  // Row lines
  const rowLines = rows.map((r) => {
    const dot    = r.kind ? DOT[r.kind] + ' ' : '  ';
    const label  = palette.dim(padDisplayRight(truncateDisplay(r.label, maxLabel), maxLabel));
    const gap    = ' '.repeat(LABEL_GAP);
    const displayVal = truncateDisplay(r.value, valColW);
    const value  = padDisplayRight(displayVal, valColW);
    const content = label + gap + dot + value;
    return pipe + '  ' + content + '  ' + pipe;
  });

  return [top, ...headerLines, sep, ...rowLines, bot].join('\n');
}
