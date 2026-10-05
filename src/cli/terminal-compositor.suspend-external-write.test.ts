/**
 * Issue #2382 / PR #2390 — suspend-external-write: real assertions.
 *
 * Promoted from the `.repro` measurement file. Covers:
 *
 *   S2 — scrolling external write during suspension: the owner writes enough
 *        newline-terminated lines to scroll the viewport by ≥3 rows, then a
 *        commitAbove(BLOCK-S) fires while suspended, then resumeInput().
 *        BLOCK-S and all prior blocks must each appear exactly once.
 *
 *   S3 — control (non-scrolling write): same as S2 but the owner writes
 *        only a prompt without a trailing newline. Same exactness invariant.
 *
 *   disarm-while-suspended with queue: an S2-style setup where the owner
 *        writes a scrolling run, BLOCK-S is queued, then disarm() fires
 *        (Ctrl-C / abort) before resumeInput(). Every block — including
 *        BLOCK-S — must appear in the post-disarm scrollback exactly once.
 *
 *   pending-at-suspend: commit a block that lands in the band-hold model as
 *        FULLY PENDING (overlay covers the full viewport so repaint sees no
 *        room), then suspend. The pending model must be settled to scrollback
 *        before the owner takes the screen so no phantom rows appear on
 *        resume. Verified by asserting the queued commit BLOCK-S appears
 *        exactly once after resume.
 *
 * Matrix: the 6 modes from suspend-commit.test.ts:
 *   bottom-pin × {no-banner, banner}
 *   content-hug with slack × {no-banner, banner}
 *   content-hug hugSlack==0 × {no-banner, banner}
 *
 * S1 (ESC[2J task-view blanking) is out of scope here — it is handled by the
 * separate task-view alt-screen PR.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: () => MockStdin;
};

const COLS = 80;
const ROWS = 24;
const BANNER_ROWS = 6;

function makeStdout(): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = ROWS;
  return s;
}

function makeStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = function () { return s; };
  return s;
}

function attachScreen(stdout: MockStdout): VirtualScreen {
  const vs = new VirtualScreen(COLS, ROWS);
  stdout.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) vs.write(chunk);
    else if (typeof chunk === 'string') vs.write(Buffer.from(chunk, 'utf-8'));
  });
  return vs;
}

interface Scenario {
  name: string;
  contentHug: boolean;
  banner: boolean;
  fill: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'bottom-pin, no banner',               contentHug: false, banner: false, fill: 0 },
  { name: 'bottom-pin, banner',                  contentHug: false, banner: true,  fill: 0 },
  { name: 'content-hug with slack, no banner',   contentHug: true,  banner: false, fill: 0 },
  { name: 'content-hug with slack, banner',      contentHug: true,  banner: true,  fill: 0 },
  { name: 'content-hug hugSlack==0, no banner',  contentHug: true,  banner: false, fill: ROWS },
  { name: 'content-hug hugSlack==0, banner',     contentHug: true,  banner: true,  fill: ROWS },
];

interface Rig {
  c: TerminalCompositor;
  vs: VirtualScreen;
  stdout: MockStdout;
  repaint: () => void;
}

async function makeRig(s: Scenario): Promise<Rig> {
  const stdout = makeStdout();
  const vs = attachScreen(stdout);
  if (s.banner) {
    for (let i = 0; i < BANNER_ROWS; i++) stdout.write(`BANNER_LINE_${i}\n`);
  }
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: () => {},
    anchorRow: s.banner ? BANNER_ROWS + 1 : 1,
    ...(s.contentHug ? { contentHug: true } : {}),
  });
  await c.arm();
  const raw = c as unknown as { repaint(): void };
  return { c, vs, stdout, repaint: () => raw.repaint() };
}

function dumpScreen(vs: VirtualScreen): string {
  return [
    ...vs.scrollbackLines().map((l, i) => `[sb-${String(i).padStart(3)}] ${JSON.stringify(l)}`),
    ...vs.visibleLines().map((l, i) => `[vp-${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`),
  ].join('\n');
}

/** Count exact trimmed matches across scrollback + viewport. */
function countLabel(vs: VirtualScreen, label: string): number {
  return [...vs.scrollbackLines(), ...vs.visibleLines()].filter((l) => l.trim() === label).length;
}

/** Assert every label appears exactly once. */
function assertExactlyOnce(vs: VirtualScreen, labels: string[], tag: string): void {
  const dump = dumpScreen(vs);
  for (const label of labels) {
    const count = countLabel(vs, label);
    expect(count, `[${tag}] "${label}" must appear exactly once (found ${count}):\n${dump}`).toBe(1);
  }
}

describe('suspend-external-write (issue #2382, S2/S3/disarm/pending)', () => {
  for (const s of SCENARIOS) {
    // ------------------------------------------------------------------
    // S2: scrolling external write + commitAbove while suspended + resume
    // ------------------------------------------------------------------
    it(`S2 scrolling write + commitAbove + resume — ${s.name}`, async () => {
      const { c, vs, stdout, repaint } = await makeRig(s);

      // Land FILL blocks + BLOCK-A + BLOCK-B, repaint so they're in the model.
      for (let i = 0; i < s.fill; i++) {
        c.commitAbove(`FILL-${String(i).padStart(2, '0')}\n`);
        repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      repaint();

      // Suspend — owner takes the screen.
      c.suspendInput();

      // Owner writes enough newline-terminated lines to scroll ≥3 rows.
      // ROWS+3 guarantees that even with an anchored region, at least 3
      // scroll events occur.
      for (let i = 0; i < ROWS + 3; i++) {
        stdout.write(`SCROLL-LINE-${String(i).padStart(3, '0')}\n`);
      }

      // commitAbove while suspended — must be queued, not written.
      c.commitAbove('BLOCK-S\n');

      // Resume — queue is replayed through fresh commit path.
      c.resumeInput();

      const labels = [
        ...Array.from({ length: s.fill }, (_, i) => `FILL-${String(i).padStart(2, '0')}`),
        'BLOCK-A',
        'BLOCK-B',
        'BLOCK-S',
      ];
      assertExactlyOnce(vs, labels, `S2/${s.name}`);

      c.disarm();
    });

    // ------------------------------------------------------------------
    // S3: non-scrolling write + commitAbove while suspended + resume
    // ------------------------------------------------------------------
    it(`S3 non-scrolling write + commitAbove + resume — ${s.name}`, async () => {
      const { c, vs, stdout, repaint } = await makeRig(s);

      for (let i = 0; i < s.fill; i++) {
        c.commitAbove(`FILL-${String(i).padStart(2, '0')}\n`);
        repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      repaint();

      c.suspendInput();

      // Non-scrolling write: moves cursor but emits no newline.
      stdout.write('PROMPT? ');

      c.commitAbove('BLOCK-S\n');

      c.resumeInput();

      const labels = [
        ...Array.from({ length: s.fill }, (_, i) => `FILL-${String(i).padStart(2, '0')}`),
        'BLOCK-A',
        'BLOCK-B',
        'BLOCK-S',
      ];
      assertExactlyOnce(vs, labels, `S3/${s.name}`);

      c.disarm();
    });

    // ------------------------------------------------------------------
    // disarm while suspended with a queued commit
    // ------------------------------------------------------------------
    it(`disarm-while-suspended with queue — ${s.name}`, async () => {
      const { c, vs, stdout, repaint } = await makeRig(s);

      for (let i = 0; i < s.fill; i++) {
        c.commitAbove(`FILL-${String(i).padStart(2, '0')}\n`);
        repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      repaint();

      c.suspendInput();

      // Owner writes a scrolling run — same as S2.
      for (let i = 0; i < ROWS + 3; i++) {
        stdout.write(`SCROLL-LINE-${String(i).padStart(3, '0')}\n`);
      }

      // Queue a commit.
      c.commitAbove('BLOCK-S\n');

      // Disarm fires (Ctrl-C / abort) before resumeInput().
      // BLOCK-S must not be lost.
      c.disarm();

      const labels = [
        ...Array.from({ length: s.fill }, (_, i) => `FILL-${String(i).padStart(2, '0')}`),
        'BLOCK-A',
        'BLOCK-B',
        'BLOCK-S',
      ];
      assertExactlyOnce(vs, labels, `disarm-suspended/${s.name}`);
    });

    // ------------------------------------------------------------------
    // pending-at-suspend: fully-pending band-hold row settled before owner
    // ------------------------------------------------------------------
    it(`pending-at-suspend: settled before owner writes — ${s.name}`, async () => {
      const { c, vs, stdout, repaint } = await makeRig(s);

      for (let i = 0; i < s.fill; i++) {
        c.commitAbove(`FILL-${String(i).padStart(2, '0')}\n`);
        repaint();
      }

      // BLOCK-A and BLOCK-B are committed and then repaint() is called
      // so they're painted (committedBandPaintedRows > 0).
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      repaint();

      // BLOCK-PENDING is committed WITHOUT a repaint — in content-hug modes
      // this may be purely pending (paintedRows doesn't include it yet in
      // some paths). In any mode, suspendInput must settle this so no phantom
      // row appears.
      c.commitAbove('BLOCK-PENDING\n');

      // Suspend — must settle BLOCK-PENDING before yielding to owner.
      c.suspendInput();

      // Owner writes a scrolling run.
      for (let i = 0; i < ROWS + 3; i++) {
        stdout.write(`SCROLL-LINE-${String(i).padStart(3, '0')}\n`);
      }

      // Queue BLOCK-S while suspended.
      c.commitAbove('BLOCK-S\n');

      // Resume.
      c.resumeInput();

      const labels = [
        ...Array.from({ length: s.fill }, (_, i) => `FILL-${String(i).padStart(2, '0')}`),
        'BLOCK-A',
        'BLOCK-B',
        'BLOCK-PENDING',
        'BLOCK-S',
      ];
      assertExactlyOnce(vs, labels, `pending-at-suspend/${s.name}`);

      c.disarm();
    });
  }
});
