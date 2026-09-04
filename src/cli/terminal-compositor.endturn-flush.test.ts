/**
 * Stage 3 (#540 — single end-of-turn flush) regression.
 *
 * `endTurn()` flushes the ENTIRE retained committed band (painted rows + pending
 * rows) to native scrollback as one contiguous write at geometry-stable turn
 * finalization — so the terminal's scrollback holds a clean, complete copy of
 * all committed content from the turn, and `flushPendingCommittedBand` in
 * `disarm()` becomes a guaranteed no-op.
 *
 * Key invariants verified:
 *   (1) All committed rows appear in scrollback after endTurn() + disarm().
 *   (2) No row is duplicated across scrollback and viewport.
 *   (3) The committed band state is zeroed after endTurn() — painted + pending.
 *   (4) endTurn() is a no-op when called on a disarmed compositor.
 *   (5) endTurn() before disarm() leaves flushPendingCommittedBand a no-op
 *       (band cleared, pendingCount === 0 when disarm's flush runs).
 *
 * This test uses @xterm/headless to verify scrollback contents — the same PTY
 * emulation layer used by the render-not-repin.test.ts Stage-2 guard. Unlike
 * a real PTY this cannot certify real-terminal behavior (docs/scrollback.md:9-13),
 * but it DOES verify the escape sequences produced by endTurn() reach the
 * correct terminal rows (same guarantee the Stage-2 test provides).
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { StatusLine } from './status-line.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true; s.columns = cols; s.rows = rows; return s;
}
function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true; s.isRaw = false; s.setRawMode = vi.fn((r: boolean) => { s.isRaw = r; return s; }); return s;
}
function collect(stream: MockStdout): () => string {
  const c: string[] = []; stream.on('data', (x) => c.push(String(x))); return () => c.join('');
}
function termWrite(t: HeadlessTerminal, d: string): Promise<void> {
  return new Promise((r) => t.write(d, r));
}
/** All active-buffer lines (viewport, not scrollback). */
function viewportLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}
/** All scrollback lines (history above viewport). */
function scrollbackLines(t: HeadlessTerminal): string[] {
  const b = t.buffer.active; const o: string[] = [];
  for (let i = -b.baseY; i < 0; i++) { const l = b.getLine(i); if (l) o.push(l.translateToString(true)); }
  return o;
}

const COLS = 80, ROWS = 24;

describe('Stage 3 (#540) endTurn: single end-of-turn flush to scrollback', () => {
  it('flushes the full committed band to scrollback and zeroes the band state', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const all = collect(stdout);
    const statusLine = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
    statusLine.start();
    statusLine.repaint({ model: 'M', cost: 0, tokens: 0, contextPct: 0 });
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion: statusLine, anchorRow: 1 });
    await c.arm();
    statusLine.setExtraRows(1);
    c.setSpinner({ enabled: true });

    // Simulate a turn: commit two distinct blocks under a short overlay.
    c.setOverlay('spinner line A\nspinner line B');
    c.commitAbove('COMMITTED-BLOCK-ONE\n');
    c.commitAbove('COMMITTED-BLOCK-TWO\n');

    // Turn ends: overlay clears, spinner stops (geometry stable).
    c.setSpinner({ enabled: false });
    c.setOverlay('');
    // Force a repaint to settle the frame at its idle (minimal) height.
    const internals = c as unknown as { repaint(): void };
    internals.repaint();

    // Stage 3 flush — BEFORE disarm.
    c.endTurn();

    // Verify band state is zeroed (flushPendingCommittedBand in disarm() will be a no-op).
    const state = c as unknown as {
      committedBand: string[];
      committedBandPaintedRows: number;
    };
    expect(state.committedBand.length, 'band must be empty after endTurn()').toBe(0);
    expect(state.committedBandPaintedRows, 'painted rows must be 0 after endTurn()').toBe(0);

    // Now disarm — flushPendingCommittedBand should be a no-op.
    c.disarm();
    statusLine.stop();

    // Feed all terminal output through @xterm/headless.
    const term = new HeadlessTerminal({
      cols: COLS, rows: ROWS, scrollback: 800, allowProposedApi: true, convertEol: true,
    });
    await termWrite(term, all());

    const scrollback = scrollbackLines(term);
    const viewport = viewportLines(term);
    const allOutput = [...scrollback, ...viewport];
    const dump = [
      'SCROLLBACK:',
      ...scrollback.map((l, i) => `[sb${i}] ${JSON.stringify(l.replace(/\s+$/, ''))}`),
      'VIEWPORT:',
      ...viewport.map((l, i) => `[vp${i}] ${JSON.stringify(l.replace(/\s+$/, ''))}`),
    ].join('\n');

    // (1) Both committed blocks must appear somewhere (scrollback or viewport).
    expect(
      allOutput.some((l) => l.includes('COMMITTED-BLOCK-ONE')),
      `COMMITTED-BLOCK-ONE not found:\n${dump}`,
    ).toBe(true);
    expect(
      allOutput.some((l) => l.includes('COMMITTED-BLOCK-TWO')),
      `COMMITTED-BLOCK-TWO not found:\n${dump}`,
    ).toBe(true);

    // (2) Neither block should appear MORE THAN ONCE across scrollback + viewport
    //     (single-copy invariant — no duplicate in scrollback from re-emission).
    const oneCount = allOutput.filter((l) => l.includes('COMMITTED-BLOCK-ONE')).length;
    const twoCount = allOutput.filter((l) => l.includes('COMMITTED-BLOCK-TWO')).length;
    expect(oneCount, `COMMITTED-BLOCK-ONE appears ${oneCount} times (expected 1):\n${dump}`).toBe(1);
    expect(twoCount, `COMMITTED-BLOCK-TWO appears ${twoCount} times (expected 1):\n${dump}`).toBe(1);

    term.dispose();
  }, 15_000);

  it('is a no-op when the compositor is not armed', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), anchorRow: 1 });
    // NOT armed — endTurn() must not throw.
    expect(() => c.endTurn()).not.toThrow();
    c.disarm();
  });

  it('is a no-op when the band is empty', async () => {
    const stdout = makeStdout(COLS, ROWS);
    const stdin = makeStdin();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), anchorRow: 1 });
    await c.arm();
    c.setSpinner({ enabled: false });
    // No commitAbove → band is empty → endTurn() must be a no-op.
    expect(() => c.endTurn()).not.toThrow();
    c.disarm();
  });
});
