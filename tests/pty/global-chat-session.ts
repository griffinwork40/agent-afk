/**
 * Interactive PTY session for the global chat view tests: spawns
 * tests/pty/global-chat-driver.ts in a real pty, feeds every byte into a LIVE
 * @xterm/headless emulator as it arrives, and lets a test wait on the screen,
 * type key bytes, signal the driver, and read the driver's JSON event log.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNodePty } from './harness.js';
import { PTY_DONE_SENTINEL } from './constants.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DRIVER = fileURLToPath(new URL('./global-chat-driver.ts', import.meta.url));

interface XLine { translateToString(trim: boolean): string }
interface XTerm {
  write(d: string, cb?: () => void): void;
  resize(c: number, r: number): void;
  onTitleChange(cb: (t: string) => void): void;
  parser: { registerOscHandler(id: number, cb: (data: string) => boolean): void };
  buffer: { active: { type: 'normal' | 'alternate'; baseY: number; length: number; cursorX: number; cursorY: number; getLine(i: number): XLine | undefined } };
  modes: { bracketedPasteMode: boolean };
  dispose(): void;
}
interface Pty { onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(c: number, r: number): void; kill(sig?: string): void; pid: number }

export interface ChatSession {
  raw(): string;
  term: XTerm;
  titles: string[];
  clipboardWrites: string[];
  exitCode(): number | null;
  /** Visible rows of the active buffer. */
  screen(): string[];
  /** Every row of the normal buffer (scrollback + viewport). */
  normalLines(): string[];
  type(bytes: string): void;
  waitFor(pred: () => boolean, what: string, ms?: number): Promise<void>;
  waitForText(needle: string, ms?: number): Promise<void>;
  events(): Array<Record<string, unknown>>;
  waitForEvent(ev: string, ms?: number): Promise<Record<string, unknown>>;
  signal(sig: string): void;
  resize(cols: number, rows: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  dispose(): void;
}

export async function startChatSession(scenario: string, cols: number, rows: number): Promise<ChatSession> {
  const pty = loadNodePty();
  const xterm = await import(pathToFileURL(require.resolve('@xterm/headless')).href);
  const Terminal = ((xterm as { Terminal?: unknown }).Terminal ?? (xterm as { default?: { Terminal?: unknown } }).default?.Terminal) as new (o: Record<string, unknown>) => XTerm;
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  const titles: string[] = [];
  const clipboardWrites: string[] = [];
  term.onTitleChange((t) => titles.push(t));
  term.parser.registerOscHandler(52, (d) => { clipboardWrites.push(d); return true; });
  const logFile = join(mkdtempSync(join(tmpdir(), 'afk-gc-pty-')), 'events.jsonl');
  const child = (pty as unknown as { spawn(f: string, a: string[], o: Record<string, unknown>): Pty }).spawn(
    process.execPath, ['--import', 'tsx', DRIVER, scenario],
    { name: 'xterm-256color', cols, rows, cwd: REPO_ROOT, env: { ...process.env, TERM: 'xterm-256color', GC_LOG: logFile } },
  );
  let buf = '';
  let exit: number | null = null;
  let pending = Promise.resolve();
  child.onData((d) => {
    const done = buf.includes(PTY_DONE_SENTINEL);
    buf += d;
    if (!done) pending = pending.then(() => new Promise<void>((r) => term.write(d.split(PTY_DONE_SENTINEL)[0] ?? '', r)));
  });
  child.onExit(({ exitCode }) => { exit = exitCode; });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const rowsOf = (from: number, to: number): string[] => {
    const out: string[] = [];
    const b = term.buffer.active;
    for (let i = from; i < to; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out;
  };
  const events = (): Array<Record<string, unknown>> => (existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  const s: ChatSession = {
    raw: () => buf, term, titles, clipboardWrites, exitCode: () => exit,
    screen: () => { const b = term.buffer.active; return rowsOf(b.baseY, b.length); },
    normalLines: () => rowsOf(0, term.buffer.active.length),
    type: (bytes) => child.write(bytes),
    async waitFor(pred, what, ms = 8000) {
      const end = Date.now() + ms;
      for (;;) {
        await pending;
        if (pred()) return;
        if (Date.now() > end || exit !== null) {
          throw new Error(`timed out waiting for ${what} (exit=${exit})\nSCREEN:\n${s.screen().map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n')}\nEVENTS:${JSON.stringify(events())}`);
        }
        await sleep(25);
      }
    },
    waitForText(needle, ms) { return s.waitFor(() => s.screen().some((l) => l.includes(needle)), `"${needle}" on screen`, ms); },
    events,
    async waitForEvent(ev, ms = 8000) {
      let hit: Record<string, unknown> | undefined;
      await s.waitFor(() => { hit = events().find((e) => e['ev'] === ev); return hit !== undefined; }, `event ${ev}`, ms);
      return hit!;
    },
    signal: (sig) => { process.kill(child.pid, sig); },
    async resize(c, r) { await pending; term.resize(c, r); child.resize(c, r); },
    sleep,
    dispose() { try { child.kill(); } catch { /* gone */ } term.dispose(); },
  };
  return s;
}
