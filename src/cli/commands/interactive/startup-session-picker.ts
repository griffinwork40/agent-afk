/**
 * Startup session picker (#4692) — shown at REPL boot when more than one
 * resumable session exists and stdin is a TTY.
 *
 * Runs BEFORE `bootstrapSession` and before the TerminalCompositor is armed,
 * so it cannot use the compositor's picker machinery. Instead it owns raw
 * stdin directly for the brief duration of the pick, then restores cooked
 * mode before returning. The compositor is never touched.
 *
 * UX shape:
 *
 *   Resume a previous session?
 *   ▸ 5m ago    sonnet   3 turns    $0.01    my-session
 *     1h ago    opus     12 turns   $0.08    another-session
 *     (N sessions — ↑/↓ navigate · enter select · esc/enter-on-empty start new)
 *
 * Respects `AFK_SESSION_PICKER=0` to suppress (CI/scripts).
 * Only fires when stdin is a TTY and more than one non-daemon session exists.
 * Selection returns the selected session id; Esc or Enter on the "new" row
 * returns undefined (start a fresh session).
 *
 * Contract: never throws. All errors are swallowed so a corrupt session
 * directory cannot prevent the REPL from starting.
 */

import * as readline from 'node:readline';

import { palette } from '../../palette.js';
import { listSessions } from '../../session-store.js';
import { formatCost } from '../../format-utils.js';
import { env } from '../../../config/env.js';
import { resolveRepoRootSync } from '../../../utils/git.js';

// ---------------------------------------------------------------------------
// Label helpers (mirror /resume's pickLabel for visual consistency)
// ---------------------------------------------------------------------------

type SessionEntry = ReturnType<typeof listSessions>[number];

function fmtWhen(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—'.padEnd(9);
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now'.padEnd(9);
  if (diffMin < 60) return `${diffMin}m ago`.padEnd(9);
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`.padEnd(9);
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`.padEnd(9);
  const d = new Date(ts);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  return `${mon} ${d.getDate()}`.padEnd(9);
}

function pickLabel(e: SessionEntry): string {
  const when = fmtWhen(e.savedAt);
  const model = e.model.padEnd(7);
  const turns = `${e.totalTurns} turn${e.totalTurns === 1 ? '' : 's'}`.padEnd(9);
  const cost = formatCost(e.totalCostUsd).padStart(8);
  return `${when}  ${model}  ${turns}  ${cost}  ${e.name ?? e.id}`;
}

/** Deduplicate labels by appending the sidecar id when two entries collide. */
function uniquePickLabels(entries: readonly SessionEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const l = pickLabel(e);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return entries.map((e) => {
    const l = pickLabel(e);
    return (counts.get(l) ?? 0) > 1 ? `${l}  ${e.id}` : l;
  });
}

// ---------------------------------------------------------------------------
// Minimal raw-stdin single-select picker (pre-compositor)
// ---------------------------------------------------------------------------

/** Cap the displayed list at this many entries so the picker stays compact. */
const MAX_DISPLAY = 15;

/** ANSI helpers (avoid importing chalk here — keep this module slim). */
const ESC = '\x1b';
const CURSOR_UP = (n: number): string => `${ESC}[${n}A`;
const ERASE_LINE = `${ESC}[2K\r`;
const CURSOR_HIDE = `${ESC}[?25l`;
const CURSOR_SHOW = `${ESC}[?25h`;
const BOLD = (s: string): string => `${ESC}[1m${s}${ESC}[0m`;
const DIM = (s: string): string => `${ESC}[2m${s}${ESC}[0m`;
const BRAND = (s: string): string => `${ESC}[36m${s}${ESC}[0m`; // cyan

const GLYPH_CURSOR = '▸';
const GLYPH_GUTTER = ' ';

interface PickerState {
  cursor: number;
  /** `options` has N session rows + 1 "Start a new session" sentinel row. */
  options: string[];
  /** Number of rendered lines on screen (updated by render). */
  renderedLines: number;
}

/** Render the picker to stdout, erasing the previous frame first. */
function render(state: PickerState, header: readonly string[]): void {
  const lines: string[] = [];
  for (const h of header) lines.push(h);
  for (let i = 0; i < state.options.length; i++) {
    const isCursor = i === state.cursor;
    const glyph = isCursor ? BRAND(GLYPH_CURSOR) : GLYPH_GUTTER;
    // Last option is the "new session" sentinel — always dim.
    const isNew = i === state.options.length - 1;
    const label = isNew
      ? DIM(state.options[i] ?? '')
      : isCursor
        ? BOLD(state.options[i] ?? '')
        : DIM(state.options[i] ?? '');
    lines.push(`  ${glyph} ${label}`);
  }
  lines.push(DIM('  ↑/↓ navigate · enter select · esc start new'));

  // Erase previous frame (cursor is at end of last render's last line).
  if (state.renderedLines > 0) {
    // Move up to the first line, then erase each line.
    process.stdout.write(CURSOR_UP(state.renderedLines - 1));
    for (let i = 0; i < state.renderedLines; i++) {
      process.stdout.write(ERASE_LINE);
      if (i < state.renderedLines - 1) process.stdout.write('\n');
    }
    // Back to the top of the erased block.
    if (state.renderedLines > 1) {
      process.stdout.write(CURSOR_UP(state.renderedLines - 1));
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
  state.renderedLines = lines.length;
}

/** Erase the picker frame and restore cursor to start of first line. */
function erase(renderedLines: number): void {
  if (renderedLines <= 0) return;
  process.stdout.write(CURSOR_UP(renderedLines - 1));
  for (let i = 0; i < renderedLines; i++) {
    process.stdout.write(ERASE_LINE);
    if (i < renderedLines - 1) process.stdout.write('\n');
  }
  if (renderedLines > 1) process.stdout.write(CURSOR_UP(renderedLines - 1));
}

/**
 * Run the raw-stdin picker synchronously (via blocking keypress wait).
 * Returns the index into `options` that was selected (0-based), or
 * `options.length - 1` (the "new session" sentinel) on Esc.
 */
async function runRawPicker(
  header: readonly string[],
  options: string[],
  signal: AbortSignal,
): Promise<number> {
  // Append the "new session" sentinel row.
  const allOptions = [...options, '+ Start a new session'];

  const state: PickerState = {
    cursor: 0,
    options: allOptions,
    renderedLines: 0,
  };

  // Hide cursor while picker is active.
  process.stdout.write(CURSOR_HIDE);
  render(state, header);

  return new Promise<number>((resolve) => {
    if (signal.aborted) {
      process.stdout.write(CURSOR_SHOW);
      resolve(allOptions.length - 1);
      return;
    }

    // Enable raw mode so we get individual keystrokes.
    try { process.stdin.setRawMode?.(true); } catch { /* non-TTY guard */ }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();

    let resolved = false;

    const finish = (idx: number): void => {
      if (resolved) return;
      resolved = true;
      try { process.stdin.setRawMode?.(false); } catch { /* ok */ }
      process.stdin.removeListener('keypress', onKey);
      signal.removeEventListener('abort', onAbort);
      erase(state.renderedLines);
      process.stdout.write(CURSOR_SHOW);
      resolve(idx);
    };

    const onAbort = (): void => finish(allOptions.length - 1);
    signal.addEventListener('abort', onAbort, { once: true });

    const onKey = (
      _char: string | undefined,
      key: { name?: string; ctrl?: boolean; sequence?: string } | undefined,
    ): void => {
      if (!key) return;
      // Ctrl+C / Ctrl+D — treat as Esc (start new).
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        finish(allOptions.length - 1);
        return;
      }
      if (key.name === 'escape') {
        finish(allOptions.length - 1);
        return;
      }
      if (key.name === 'return') {
        finish(state.cursor);
        return;
      }
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        state.cursor = state.cursor === 0 ? allOptions.length - 1 : state.cursor - 1;
        render(state, header);
        return;
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        state.cursor = state.cursor === allOptions.length - 1 ? 0 : state.cursor + 1;
        render(state, header);
        return;
      }
    };

    process.stdin.on('keypress', onKey);
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface StartupPickerResult {
  /** The id of the selected session, or undefined to start fresh. */
  selectedId: string | undefined;
}

/**
 * Show the startup session picker if conditions are met.
 *
 * Conditions (all must hold):
 *   1. `AFK_SESSION_PICKER` is not set to `0`
 *   2. stdin is a TTY
 *   3. More than one non-daemon CLI session exists
 *   4. `--resume` / `--continue` was not already supplied (no-op if already resuming)
 *
 * Returns `{ selectedId: string }` on selection, or `{ selectedId: undefined }`
 * to start a new session. Never throws.
 */
export async function runStartupSessionPicker(opts: {
  /** Already-resolved resume from CLI flags — skip picker if set. */
  alreadyResuming: boolean;
  /** AbortSignal that dismisses the picker (e.g. SIGINT before compositor arms). */
  signal: AbortSignal;
}): Promise<StartupPickerResult> {
  try {
    // Respect suppression env var.
    const pickerEnv = env.AFK_SESSION_PICKER;
    if (pickerEnv === '0' || pickerEnv === 'false') return { selectedId: undefined };

    // Skip when CLI already specifies a session.
    if (opts.alreadyResuming) return { selectedId: undefined };

    // TTY guard — picker is meaningless on pipes / CI.
    if (!process.stdin.isTTY || !process.stdout.isTTY) return { selectedId: undefined };

    // Load sessions — filter to CLI/non-daemon entries only.
    let entries = listSessions().filter(
      (e) => e.source !== 'daemon' && e.source !== 'telegram',
    );

    // Need at least two sessions to make a picker worthwhile.
    if (entries.length < 2) return { selectedId: undefined };

    // Filter to sessions from the current repo when possible.
    const cwd = process.cwd();
    let repoRoot: string | undefined;
    try { repoRoot = resolveRepoRootSync({ cwd, mode: 'git-common-dir' }); } catch { /* not a git repo */ }

    const repoRootCache = new Map<string, string | undefined>();
    const cachedRepoRoot = (eCwd: string): string | undefined => {
      if (repoRootCache.has(eCwd)) return repoRootCache.get(eCwd);
      let root: string | undefined;
      try { root = resolveRepoRootSync({ cwd: eCwd, mode: 'git-common-dir' }); } catch { /* noop */ }
      repoRootCache.set(eCwd, root);
      return root;
    };

    const localEntries = entries.filter((e) => {
      if (repoRoot) {
        if (e.repoRoot) return e.repoRoot === repoRoot;
        if (e.cwd) return cachedRepoRoot(e.cwd) === repoRoot;
      }
      return e.cwd === cwd;
    });

    // Use local sessions when available, otherwise fall back to all sessions.
    const displayEntries = localEntries.length >= 2 ? localEntries : entries;
    if (displayEntries.length < 2) return { selectedId: undefined };

    const shown = displayEntries.slice(0, MAX_DISPLAY);
    const labels = uniquePickLabels(shown);

    const hiddenCount = displayEntries.length - shown.length;
    const scopeNote = localEntries.length >= 2
      ? `saved in this repo${hiddenCount > 0 ? ` · ${hiddenCount} more hidden` : ''}`
      : `all directories${hiddenCount > 0 ? ` · ${hiddenCount} more hidden` : ''}`;

    const header = [
      palette.bold('Resume a previous session?'),
      palette.dim(`  ${scopeNote}`),
      '',
    ];

    const idx = await runRawPicker(header, labels, opts.signal);

    // Last option is "Start a new session" sentinel.
    if (idx >= shown.length) return { selectedId: undefined };

    const selected = shown[idx];
    if (!selected) return { selectedId: undefined };

    return { selectedId: selected.name ?? selected.id };
  } catch {
    // Never crash bootstrap.
    return { selectedId: undefined };
  }
}
