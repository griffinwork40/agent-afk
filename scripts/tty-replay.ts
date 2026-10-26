#!/usr/bin/env tsx
/**
 * tty-replay.ts — replay an asciinema v2 cast through @xterm/headless
 * and print the final screen state (with row numbers) so stale-row
 * rendering bugs can be diagnosed without a real terminal.
 *
 * Usage:
 *   pnpm exec tsx scripts/tty-replay.ts <cast-file> [--at <seconds>] [--until-match <text>] [--cols N] [--rows N]
 *
 *   <cast-file>        Path to an asciinema v2 cast produced by AFK_TTY_TRACE.
 *   --at <seconds>     Stop at this timestamp instead of the end of the cast.
 *   --until-match <t>  Stop at the first "o" event whose data contains <t>.
 *   --cols / --rows    Override the initial size (default: the cast header, or
 *                      80x24 when the header recorded 0, e.g. a sizeless PTY).
 *
 * Output: numbered terminal rows at the chosen snapshot point, printed to stdout.
 *
 * Requires @xterm/headless (already a devDependency). If the import fails this
 * script exits with a clear message rather than a raw stack trace.
 */

import * as fs from 'node:fs';

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(
    'Usage: pnpm exec tsx scripts/tty-replay.ts <cast> [--at <seconds>] [--until-match <text>] [--cols N] [--rows N]\n',
  );
  process.exit(0);
}

const castPath = args[0]!;
let atSeconds: number | undefined;
let untilMatch: string | undefined;
let colsOverride: number | undefined;
let rowsOverride: number | undefined;

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--at' && args[i + 1] !== undefined) {
    atSeconds = parseFloat(args[i + 1]!);
    i++;
  } else if (args[i] === '--until-match' && args[i + 1] !== undefined) {
    untilMatch = args[i + 1]!;
    i++;
  } else if (args[i] === '--cols' && args[i + 1] !== undefined) {
    colsOverride = parseInt(args[i + 1]!, 10);
    i++;
  } else if (args[i] === '--rows' && args[i + 1] !== undefined) {
    rowsOverride = parseInt(args[i + 1]!, 10);
    i++;
  }
}

if (!fs.existsSync(castPath)) {
  process.stderr.write(`tty-replay: file not found: ${castPath}\n`);
  process.exit(1);
}

// ── Load @xterm/headless ─────────────────────────────────────────────────────

// Dynamic import so a missing dependency produces a helpful message, not a
// raw module-not-found stack trace.
let Terminal: { new(opts: { cols: number; rows: number; allowProposedApi?: boolean }): XTermLike };

interface XTermLike {
  cols: number;
  rows: number;
  resize(cols: number, rows: number): void;
  write(data: string, cb?: () => void): void;
  buffer: {
    active: {
      length: number;
      baseY: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | null;
    };
  };
}

try {
  // @xterm/headless exports Terminal from its package root.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await import('@xterm/headless');
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
  Terminal = (mod as any).Terminal ?? (mod as any).default?.Terminal ?? (mod as any).default;
  if (typeof Terminal !== 'function') throw new Error('Terminal constructor not found in @xterm/headless');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `tty-replay: could not load @xterm/headless: ${msg}\n` +
      `  Is it installed? Check devDependencies in package.json.\n`,
  );
  process.exit(1);
}

// ── Parse cast file ──────────────────────────────────────────────────────────

interface CastHeader {
  version: number;
  width: number;
  height: number;
}

type CastEvent = [number, 'o' | 'r', string];

const lines = fs.readFileSync(castPath, 'utf8').split('\n').filter(Boolean);
if (lines.length === 0) {
  process.stderr.write('tty-replay: cast file is empty\n');
  process.exit(1);
}

const header = JSON.parse(lines[0]!) as CastHeader;
if (header.version !== 2) {
  process.stderr.write(`tty-replay: unsupported cast version ${header.version} (expected 2)\n`);
  process.exit(1);
}

const events: CastEvent[] = [];
for (const line of lines.slice(1)) {
  try {
    events.push(JSON.parse(line) as CastEvent);
  } catch {
    // Skip malformed lines (e.g. trailing partial write on crash).
  }
}

// ── Replay into headless terminal ────────────────────────────────────────────

// A header size of 0 means the recorder saw no window size (sizeless PTY);
// xterm would clamp to a useless 2x1, so fall back to 80x24.
const positive = (n: number | undefined): number | undefined =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
const startCols = positive(colsOverride) ?? positive(header.width) ?? 80;
const startRows = positive(rowsOverride) ?? positive(header.height) ?? 24;
const term = new Terminal({ cols: startCols, rows: startRows, allowProposedApi: true });

// Invariant (xterm write is async): Terminal.write() only queues data; the
// parser drains it on a later tick. Each write must be awaited before the next
// event so a resize applies to the screen state the bytes before it produced,
// and so the final snapshot is not read from an unparsed (blank) buffer.
const writeAsync = (data: string): Promise<void> =>
  new Promise<void>((resolve) => term.write(data, resolve));

for (const [t, kind, data] of events) {
  // Stop conditions
  if (atSeconds !== undefined && t > atSeconds) break;

  if (kind === 'r') {
    // Resize event: data is "COLSxROWS"
    const [colsStr, rowsStr] = data.split('x');
    const cols = parseInt(colsStr ?? '80', 10);
    const rows = parseInt(rowsStr ?? '24', 10);
    if (!isNaN(cols) && !isNaN(rows) && cols > 0 && rows > 0) {
      term.resize(cols, rows);
    }
  } else if (kind === 'o') {
    await writeAsync(data);
    if (untilMatch !== undefined && data.includes(untilMatch)) break;
  }
}

// ── Print screen ─────────────────────────────────────────────────────────────

const buf = term.buffer.active;
const numRows = buf.length;

// Scrollback rows print as `h<n>`; visible screen rows print 1-based so they
// match the CUP row numbers (`ESC[<row>;1H`) in the cast.
console.log(`\n── Terminal snapshot (${term.cols}×${term.rows}) ──\n`);
for (let y = 0; y < numRows; y++) {
  if (y === buf.baseY) console.log('── visible screen (rows are CUP-addressable) ──');
  const line = buf.getLine(y);
  const text = line ? line.translateToString(true) : '';
  const rowLabel = y < buf.baseY ? `h${y}`.padStart(4, ' ') : String(y - buf.baseY + 1).padStart(4, ' ');
  console.log(`${rowLabel}: ${text}`);
}
console.log('\n── End of snapshot ──\n');
