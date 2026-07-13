/**
 * PTY scrollback harness — parent-side spawn/capture/reconstruct machinery
 * (issue #541). Imported by tests/pty/compositor-scrollback.pty.test.ts.
 *
 * Pipeline:
 *   1. Spawn `node --import tsx tests/pty/driver.ts <scenario>` inside a REAL
 *      pseudo-terminal (node-pty) sized to the scenario's cols×rows.
 *   2. Accumulate the child's byte stream until the driver's APC sentinel.
 *   3. Replay the captured bytes (everything BEFORE the sentinel) into an
 *      @xterm/headless emulator sized to the same geometry.
 *   4. Return the parsed buffer split into scrollback (rows above baseY) and
 *      viewport (the visible rows), so tests can assert on real scrollback.
 *
 * Why real pty + real emulator, not the in-process mock: docs/scrollback.md
 * (9-13, 108-111) is explicit that mock-stdout tests confirm bytes were
 * WRITTEN but cannot confirm they reached SCROLLBACK — that is a property of a
 * real terminal's scroll engine driven over a real pty (real isTTY, real
 * winsize, real kernel flush), not of the bytes alone.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PTY_DONE_SENTINEL } from './constants.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DRIVER_PATH = fileURLToPath(new URL('./driver.ts', import.meta.url));

/** Minimal shape of the bits of node-pty we use (avoids a type dependency). */
interface IPtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}
interface NodePtyModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): IPtyProcess;
}

/**
 * node-pty ships a `spawn-helper` executable next to its native binary. pnpm's
 * content-addressable store extraction drops the file's executable bit on macOS
 * (a known node-pty + pnpm interaction), which makes posix_spawnp fail. Restore
 * it (idempotent; no-op where already +x, e.g. Linux source builds). This is
 * self-healing so the harness works regardless of how node-pty was installed.
 */
export function ensureNodePtyExecutable(): void {
  let pkgDir: string;
  try {
    pkgDir = dirname(require.resolve('node-pty/package.json'));
  } catch {
    return; // node-pty not installed; loadNodePty() will surface the real error.
  }
  const candidates: string[] = [join(pkgDir, 'build', 'Release', 'spawn-helper')];
  const prebuilds = join(pkgDir, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      candidates.push(join(prebuilds, entry, 'spawn-helper'));
    }
  }
  for (const p of candidates) {
    try {
      if (existsSync(p) && statSync(p).isFile()) chmodSync(p, 0o755);
    } catch {
      /* best-effort */
    }
  }
}

let cachedPty: NodePtyModule | null = null;
/** Load node-pty (self-healing the spawn-helper bit first). Throws if absent. */
export function loadNodePty(): NodePtyModule {
  if (cachedPty) return cachedPty;
  ensureNodePtyExecutable();
  cachedPty = require('node-pty') as NodePtyModule;
  return cachedPty;
}

/** Is node-pty importable and functional? Used to gate the suite locally. */
export function nodePtyAvailable(): { ok: true } | { ok: false; reason: string } {
  try {
    loadNodePty();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message ?? String(err) };
  }
}

export interface PtyRunResult {
  /** Bytes captured up to (not including) the sentinel — fed to the emulator. */
  raw: string;
  /** Whether the sentinel was seen (vs. capturing everything up to exit). */
  sawSentinel: boolean;
  exitCode: number | 'timeout';
  /** All emulator buffer lines, top (oldest scrollback) → bottom. */
  lines: string[];
  /** First visible row index — lines[0..baseY) are scrollback. */
  baseY: number;
  /** Scrollback region (rows above the viewport), blank rows preserved. */
  scrollback: string[];
  /** Viewport region (the visible rows). */
  viewport: string[];
  /** Pretty numbered dump of every line, for failure messages. */
  dump(): string;
}

export interface RunScenarioOpts {
  name: string;
  cols: number;
  rows: number;
  timeoutMs?: number;
}

/** Spawn a scenario in a real pty and reconstruct its emulator buffer. */
export async function runScenarioInPty(opts: RunScenarioOpts): Promise<PtyRunResult> {
  const { name, cols, rows, timeoutMs = 20_000 } = opts;
  const pty = loadNodePty();
  const xterm = await import(pathToFileURL(require.resolve('@xterm/headless')).href);
  const Terminal = (xterm as { Terminal?: unknown }).Terminal
    ?? (xterm as { default?: { Terminal?: unknown } }).default?.Terminal;
  if (typeof Terminal !== 'function') throw new Error('@xterm/headless: Terminal constructor not found');

  const child = pty.spawn(process.execPath, ['--import', 'tsx', DRIVER_PATH, name], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: REPO_ROOT,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  let buf = '';
  let captured: string | null = null;
  child.onData((d) => {
    buf += d;
    if (captured === null) {
      const idx = buf.indexOf(PTY_DONE_SENTINEL);
      if (idx >= 0) captured = buf.slice(0, idx);
    }
  });

  const exitCode = await new Promise<number | 'timeout'>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* already gone */ }
      resolve('timeout');
    }, timeoutMs);
    child.onExit(({ exitCode }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  const sawSentinel = captured !== null;
  const raw = captured ?? buf;

  // Real pty output already carries CRLF (kernel ONLCR), so do NOT set
  // convertEol — that would double-translate and desync every row.
  const term = new (Terminal as new (o: Record<string, unknown>) => {
    write(d: string, cb: () => void): void;
    buffer: { active: { baseY: number; length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } };
    dispose(): void;
  })({ cols, rows, scrollback: 1000, allowProposedApi: true });
  await new Promise<void>((r) => term.write(raw, r));

  const b = term.buffer.active;
  const baseY = b.baseY;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i);
    lines.push(l ? l.translateToString(true).replace(/\s+$/, '') : '');
  }
  term.dispose();

  const scrollback = lines.slice(0, baseY);
  const viewport = lines.slice(baseY);

  return {
    raw,
    sawSentinel,
    exitCode,
    lines,
    baseY,
    scrollback,
    viewport,
    dump(): string {
      return lines
        .map((l, i) => `[${i < baseY ? 'SB' : 'VP'} ${String(i).padStart(3)}] ${JSON.stringify(l)}`)
        .join('\n');
    },
  };
}

/** Count the largest run of consecutive blank rows within lines[from..to]. */
export function maxBlankRun(lines: string[], from: number, to: number): number {
  let cur = 0;
  let max = 0;
  for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) {
    if ((lines[i] ?? '').trim() === '') { cur += 1; max = Math.max(max, cur); }
    else cur = 0;
  }
  return max;
}
