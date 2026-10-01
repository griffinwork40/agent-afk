/**
 * Terminal color discovery: ask the terminal what its default foreground,
 * background, and 16-color palette actually are (OSC 10 / 11 / 4 queries),
 * once per process, so the text reveal can fade each letter toward the color
 * the terminal will really draw instead of guessing from a theme table.
 *
 * Why it matters: plain prose carries no SGR foreground, so without this the
 * reveal cannot know its settled color and falls back to a coarse
 * faint-then-normal hand-off. On a dim-foreground theme (Classic Repaired is
 * #8A8A8A on black) the old theme-table guess even darkened mid-fade.
 *
 * Invariant (stdin ownership): the query runs BEFORE any other stdin consumer
 * exists: `createReplInputAfterColorQuery` (bootstrap-wiring.ts) awaits it
 * immediately before creating the REPL's readline interface, and the boot
 * spinner uses `discardStdin: false`. The reply is read in raw mode by a single
 * listener that is removed before the function resolves. Any bytes that are
 * NOT part of a recognized reply (user typeahead during the window) are
 * pushed back with `stdin.unshift()` so nothing typed is lost.
 *
 * Invariant (bounded wait): a DA1 query (`ESC [ c`) is sent last. Terminals
 * answer in order and every terminal answers DA1, so its reply means "all
 * replies are in". Terminals that ignore OSC finish on the DA1 reply alone;
 * a hard timeout bounds the pathological case.
 *
 * @module cli/terminal-colors
 */

import type { Rgb } from './smoke-reveal.tones.js';

export interface TerminalColors {
  fg: Rgb | null;
  bg: Rgb | null;
  /** Palette entries 0-15 the terminal reported (missing indices stay absent). */
  palette: ReadonlyMap<number, Rgb>;
}

/** Default wait for the DA1 sentinel before giving up. */
export const QUERY_TIMEOUT_MS = 150;

const ST = '\u001b\\';
const DA1 = '\u001b[c';
// OSC reply: ESC ] <10|11|4;n> ; <spec> (BEL | ESC \)
const OSC_REPLY_RE = /\u001b\](10|11|4;(\d{1,3}));([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
// DA1 reply: ESC [ ? <params> c
const DA1_REPLY_RE = /\u001b\[\?[\d;]*c/;

let discovered: TerminalColors | null = null;

/** The colors found by `discoverTerminalColors`, or null when unknown. */
export function getTerminalColors(): TerminalColors | null {
  return discovered;
}

/** Test seam and escape hatch: set (or clear) the discovered colors. */
export function setTerminalColors(colors: TerminalColors | null): void {
  discovered = colors;
}

/** Parse one X11 color spec (`rgb:R/G/B`, 1-4 hex digits per channel, or `#RRGGBB`). */
export function parseColorSpec(spec: string): Rgb | null {
  const s = spec.trim();
  const rgb = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i.exec(s);
  if (rgb) {
    const ch = (h: string): number => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255);
    return [ch(rgb[1] ?? '0'), ch(rgb[2] ?? '0'), ch(rgb[3] ?? '0')];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1] ?? '0', 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

export interface ParsedReplies {
  colors: TerminalColors;
  /** True once the DA1 sentinel reply has been seen. */
  done: boolean;
  /** Input with every recognized reply removed (typeahead to hand back). */
  rest: string;
}

/** Extract every OSC color reply and the DA1 sentinel from raw terminal input. */
export function parseReplies(input: string): ParsedReplies {
  let fg: Rgb | null = null;
  let bg: Rgb | null = null;
  const palette = new Map<number, Rgb>();
  for (const m of input.matchAll(OSC_REPLY_RE)) {
    const color = parseColorSpec(m[3] ?? '');
    if (!color) continue;
    if (m[1] === '10') fg = color;
    else if (m[1] === '11') bg = color;
    else {
      const idx = Number(m[2]);
      if (idx >= 0 && idx < 16) palette.set(idx, color);
    }
  }
  const done = DA1_REPLY_RE.test(input);
  const rest = input.replace(OSC_REPLY_RE, '').replace(DA1_REPLY_RE, '');
  return { colors: { fg, bg, palette }, done, rest };
}

/** The query bytes: default fg, default bg, palette 0-15, then the DA1 sentinel. */
export function buildQuery(): string {
  let q = `\u001b]10;?${ST}\u001b]11;?${ST}`;
  for (let i = 0; i < 16; i++) q += `\u001b]4;${i};?${ST}`;
  return q + DA1;
}

/** Minimal stream surfaces the query needs (real process streams satisfy these). */
export interface QueryInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  isPaused?(): boolean;
  unshift?(chunk: Buffer | string): void;
}
export interface QueryOutput {
  isTTY?: boolean;
  write(data: string): unknown;
}

export interface QueryOptions {
  input: QueryInput;
  output: QueryOutput;
  timeoutMs?: number;
}

/**
 * Send the query and collect replies until the DA1 sentinel or the timeout.
 * Resolves null when not on a TTY or when the terminal reported neither fg
 * nor bg. Never rejects: any stream error resolves null.
 */
export function queryTerminalColors(opts: QueryOptions): Promise<TerminalColors | null> {
  const { input, output } = opts;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return Promise.resolve(null);
  const wasRaw = input.isRaw === true;
  const wasPaused = input.isPaused?.() ?? true;
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Invariant: teardown order is listener -> raw mode -> flow state ->
      // unshift. The listener must be gone before unshift re-emits bytes,
      // or the typeahead would be read back into our own buffer.
      input.removeListener('data', onData);
      try { input.setRawMode?.(wasRaw); } catch { /* stream closed */ }
      if (wasPaused) input.pause();
      const parsed = parseReplies(buf);
      if (parsed.rest && input.unshift) input.unshift(parsed.rest);
      const { fg, bg, palette } = parsed.colors;
      resolve(fg || bg ? { fg, bg, palette } : null);
    };
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (DA1_REPLY_RE.test(buf)) finish();
    };
    const timer = setTimeout(finish, opts.timeoutMs ?? QUERY_TIMEOUT_MS);
    timer.unref?.();
    try {
      input.setRawMode?.(true);
      input.on('data', onData);
      input.resume();
      output.write(buildQuery());
    } catch {
      finish();
    }
  });
}

/**
 * Discover the terminal's colors once and cache them for the reveal. Safe to
 * call when disabled: resolves without touching stdin.
 */
export async function discoverTerminalColors(enabled: boolean, opts?: Partial<QueryOptions>): Promise<void> {
  if (!enabled) return;
  const colors = await queryTerminalColors({
    input: opts?.input ?? (process.stdin as unknown as QueryInput),
    output: opts?.output ?? process.stdout,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (colors) setTerminalColors(colors);
}
