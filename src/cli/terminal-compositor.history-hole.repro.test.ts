/**
 * History-hole repro (operator report 2026-10-02, tmux copy-mode screenshot).
 *
 * Symptom: mid-turn, a verdict card's bottom border, the next prompt echo and a
 * tool header were missing from BOTH tmux scrollback and the live screen; the
 * screen's row 1 already showed newer rows. They reappeared in history only
 * once the turn ended.
 *
 * Cause: in content-hug mode (the REPL) rows covered by a tall live overlay
 * were kept PENDING (in the band model, never painted, never archived) until
 * the overlay emptied — both on overlay growth ("hide-on-growth") and for
 * rows committed while the overlay was tall (band-hold).
 *
 * Invariant under test: at ANY moment mid-turn, the committed lines visible in
 * scrollback + viewport form one contiguous, in-order, exactly-once run from
 * the first committed line to the newest one. No committed line may be absent
 * while a newer one is visible.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

const COLS = 80;

function makeStdout(rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = rows;
  return s;
}

function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

async function makeRig(rows: number) {
  const stdout = makeStdout(rows);
  const chunks: string[] = [];
  stdout.on('data', (d: unknown) => chunks.push(String(d)));
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    scrollRegion: {
      withFullScrollRegion<T>(fn: () => T): T {
        stdout.write('\x1b[s\x1b[r\x1b[u');
        try {
          return fn();
        } finally {
          stdout.write(`\x1b[s\x1b[1;${stdout.rows}r\x1b[u`);
        }
      },
      getExtraRows: () => 0,
    },
    anchorRow: 1,
    contentHug: true,
  });
  await c.arm();
  const term = new HeadlessTerminal({ cols: COLS, rows, scrollback: 2000, allowProposedApi: true, convertEol: true });
  let fed = 0;
  return {
    c,
    repaint: () => (c as unknown as { repaint(): void }).repaint(),
    async lines(): Promise<string[]> {
      const data = chunks.slice(fed).join('');
      fed = chunks.length;
      await new Promise<void>((r) => term.write(data, r));
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
      return out;
    },
    dispose() {
      term.dispose();
      c.disarm();
    },
  };
}

/** Every committed label up to the newest visible one is present, once, in order. */
function assertNoHole(lines: string[], committed: string[]): void {
  const dump = lines.map((l, i) => `[${String(i).padStart(3)}] ${JSON.stringify(l)}`).join('\n');
  const found = committed.map((label) => lines.filter((l) => l === label).length);
  const newest = found.map((n) => n > 0).lastIndexOf(true);
  expect(newest, `no committed line visible at all:\n${dump}`).toBeGreaterThanOrEqual(0);
  const missing = committed.slice(0, newest + 1).filter((_, i) => found[i] === 0);
  expect(missing, `history hole: older committed lines absent while newer ones are visible:\n${dump}`).toEqual([]);
  const dupes = committed.filter((_, i) => (found[i] ?? 0) > 1);
  expect(dupes, `committed lines duplicated:\n${dump}`).toEqual([]);
  const order = committed.slice(0, newest + 1).map((label) => lines.indexOf(label));
  expect(order, `committed lines out of order:\n${dump}`).toEqual([...order].sort((a, b) => a - b));
}

const label = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`);

describe.each([24, 64])('history hole mid-turn (content-hug, %i rows)', (ROWS) => {
  it('overlay growth over a full band leaves no hole at the scrollback seam', async () => {
    const rig = await makeRig(ROWS);
    const card = label('CARD', ROWS);
    rig.c.commitAbove(`${card.join('\n')}\n`);
    rig.repaint();
    rig.c.setSpinner({ enabled: true });
    rig.c.setOverlay(label('TOOL-LIVE', Math.floor(ROWS / 2)).join('\n'));
    rig.repaint();
    assertNoHole(await rig.lines(), card);
    rig.dispose();
  });

  it('commits made while a tall overlay is up leave no hole (verdict card -> echo -> tool block)', async () => {
    const rig = await makeRig(ROWS);
    const card = label('CARD', Math.floor(ROWS / 2));
    rig.c.commitAbove(`${card.join('\n')}\n`);
    rig.repaint();
    rig.c.setSpinner({ enabled: true });
    rig.c.setOverlay(label('TOOL-LIVE', Math.floor(ROWS * 0.6)).join('\n'));
    rig.repaint();
    const echo = ['ECHO-check-again'];
    rig.c.commitAbove(`${echo.join('\n')}\n`);
    rig.repaint();
    const tool = label('TOOLOUT', Math.floor(ROWS / 2));
    rig.c.commitAbove(`${tool.join('\n')}\n`);
    rig.repaint();
    assertNoHole(await rig.lines(), [...card, ...echo, ...tool]);
    rig.dispose();
  });
});
