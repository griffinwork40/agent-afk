/**
 * Issue #2382 — a `commitAbove()` that lands while the compositor is
 * suspended (`suspendInput()`: elicitation `rl.question`, the /rewind
 * selector, editor spawn, transcript) must be shown exactly once after
 * `resumeInput()`, and the prior committed band must survive.
 *
 * Invariant under test: `suspendInput()` erases the live frame
 * (`logUpdate.clear()` + `done()`) and `repaint()` no-ops while suspended, so
 * during suspension the frame top is UNKNOWN. A commit in that window must
 * take the safe band-hold deferral (hold the block in the model) and
 * `resumeInput()`'s repaint must paint it, without tripping the geometry
 * guard (terminal-compositor.geometry-assert.ts, which throws under VITEST).
 *
 * Matrix: bottom-pin and content-hug (with slack below the frame, and after
 * hugSlack has reached 0), each with and without a pre-arm banner
 * (anchorRow > 1). Every case asserts, over scrollback + viewport:
 *   - every committed block appears exactly once, in commit order;
 *   - the committed run has no blank rows inside it and hugs the frame;
 *   - when committed content has reached scrollback, viewport row 1 is not
 *     blank (no void opened at the top of the viewport).
 *
 * Harness: VirtualScreen (synchronous ANSI interpreter), same as
 * terminal-compositor.tall-overlay-strand.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

const COLS = 80;
const ROWS = 24;
const BANNER_ROWS = 6;
const FRAME_RE = /\u23af/;

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
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

function attachScreen(stdout: MockStdout): VirtualScreen {
  const vs = new VirtualScreen(COLS, ROWS);
  stdout.on('data', (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) vs.write(chunk as Buffer);
    else if (typeof chunk === 'string') vs.write(Buffer.from(chunk, 'utf-8'));
  });
  return vs;
}

interface Scenario {
  name: string;
  contentHug: boolean;
  banner: boolean;
  /** One-line commits landed before the suspend scenario (drives hugSlack to 0). */
  fill: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'bottom-pin, no banner', contentHug: false, banner: false, fill: 0 },
  { name: 'bottom-pin, banner', contentHug: false, banner: true, fill: 0 },
  { name: 'content-hug with slack, no banner', contentHug: true, banner: false, fill: 0 },
  { name: 'content-hug with slack, banner', contentHug: true, banner: true, fill: 0 },
  { name: 'content-hug hugSlack==0, no banner', contentHug: true, banner: false, fill: ROWS },
  { name: 'content-hug hugSlack==0, banner', contentHug: true, banner: true, fill: ROWS },
];

interface Rig {
  c: TerminalCompositor;
  vs: VirtualScreen;
  internals: { repaint(): void; hugSlackProbe(): number; frameTop(): number };
}

async function makeRig(s: Scenario): Promise<Rig> {
  const stdout = makeStdout();
  const vs = attachScreen(stdout);
  // A banner printed BEFORE arming, exactly like the interactive surface: the
  // compositor protects rows 1..anchorRow-1.
  if (s.banner) {
    for (let i = 0; i < BANNER_ROWS; i++) stdout.write(`BANNER_LINE_${i}\n`);
  }
  const c = new TerminalCompositor({
    stdout,
    stdin: makeStdin(),
    onCancel: vi.fn(),
    anchorRow: s.banner ? BANNER_ROWS + 1 : 1,
    ...(s.contentHug ? { contentHug: true } : {}),
  });
  await c.arm();
  const raw = c as unknown as {
    repaint(): void;
    lastMeasuredFrameTop: number;
    lastMeasuredFrameBottom: number;
    placementMode: string;
  };
  return {
    c,
    vs,
    internals: {
      repaint: () => raw.repaint(),
      // rows the hugging frame sits above the floor (absoluteBottom = ROWS-1).
      // 1-based viewport row of the live frame's top (spinner row included).
      frameTop: () => raw.lastMeasuredFrameTop,
      hugSlackProbe: () =>
        raw.placementMode === 'content-hug' ? Math.max(0, ROWS - 1 - raw.lastMeasuredFrameBottom) : 0,
    },
  };
}

function dumpScreen(vs: VirtualScreen): string {
  return [
    ...vs.scrollbackLines().map((l, i) => `[sb-${String(i).padStart(3)}] ${JSON.stringify(l)}`),
    ...vs.visibleLines().map((l, i) => `[vp-${String(i + 1).padStart(3)}] ${JSON.stringify(l)}`),
  ].join('\n');
}

function assertCommittedOnce(vs: VirtualScreen, frameTopRow: number, labels: string[], tag: string): void {
  const scrollback = vs.scrollbackLines();
  const visible = vs.visibleLines();
  const all = [...scrollback, ...visible];
  const dump = dumpScreen(vs);

  // The frame's top row is the measured frame top (the spinner row when the
  // spinner is live); the input rule must be at or below it.
  const frameVp = frameTopRow - 1;
  const ruleVp = visible.findIndex((l) => FRAME_RE.test(l));
  expect(ruleVp, `[${tag}] frame rule not found in viewport:\n${dump}`).toBeGreaterThanOrEqual(frameVp);
  expect(frameVp, `[${tag}] no measured frame top:\n${dump}`).toBeGreaterThanOrEqual(0);

  // (1) exactly once, in order (exact whole-line match: labels are left-aligned).
  const positions: number[] = [];
  for (const label of labels) {
    const hits = all.flatMap((l, i) => (l.trim() === label ? [i] : []));
    expect(hits.length, `[${tag}] "${label}" must appear exactly once (found ${hits.length}):\n${dump}`).toBe(1);
    positions.push(hits[0]!);
  }
  for (let i = 1; i < positions.length; i++) {
    expect(
      positions[i]! > positions[i - 1]!,
      `[${tag}] "${labels[i]}" must follow "${labels[i - 1]}":\n${dump}`,
    ).toBe(true);
  }

  // (2) the committed run is contiguous (one-line blocks, no separators) and
  // hugs the frame: the row right above the frame rule holds the last label.
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;
  const gaps = all.slice(first, last + 1).filter((l) => l.trim() === '').length;
  expect(gaps, `[${tag}] ${gaps} blank rows inside the committed run:\n${dump}`).toBe(0);
  const frameAbs = scrollback.length + frameVp;
  const between = all.slice(last + 1, frameAbs).filter((l) => l.trim() !== '');
  expect(between, `[${tag}] non-committed rows between the run and the frame:\n${dump}`).toEqual([]);
  expect(frameAbs - last, `[${tag}] committed run does not hug the frame:\n${dump}`).toBeLessThanOrEqual(2);

  // (3) no void at the top of the viewport once committed content has
  // scrolled into history.
  if (first < scrollback.length) {
    expect(visible[0]!.trim(), `[${tag}] blank row 1 while content is in scrollback:\n${dump}`).not.toBe('');
  }
}

/** Assert every label in `labels` appears exactly once across scrollback+viewport. */
function assertEachExactlyOnce(vs: VirtualScreen, labels: string[], tag: string): void {
  const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
  const dump = dumpScreen(vs);
  for (const l of labels) {
    const count = all.filter((r) => r.trim() === l).length;
    expect(count, `[${tag}] "${l}" must appear exactly once (found ${count}):\n${dump}`).toBe(1);
  }
}

describe('commitAbove during suspendInput (issue #2382)', () => {
  for (const s of SCENARIOS) {
    // Regression #2382 defect 1: disarm() while suspended must not duplicate
    // prior-painted band rows. erasedFramePriorBandErase() erases the painted
    // suffix before the band-hold commit marks everything pending; flushPending
    // in disarm() then archives only what was never on screen.
    it(`disarm while suspended: each block appears exactly once — ${s.name}`, async () => {
      const { c, vs } = await makeRig(s);
      c.setSpinner({ enabled: true });
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        (c as any).repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      c.suspendInput();
      c.commitAbove('BLOCK-SUSPENDED\n');
      labels.push('BLOCK-A', 'BLOCK-B', 'BLOCK-SUSPENDED');
      c.disarm();
      assertEachExactlyOnce(vs, labels, `${s.name} (disarm-while-suspended)`);
    });

    // Regression #2382 defect 2: owesRows — a band-hold commit stores
    // committedBandPaintedRows=0 (everything pending). On resume the idle
    // repaint must materialize the owed rows even when `moved=false` (the frame
    // lands at the same position as before suspend). Without the owesRows check,
    // repositionCommittedBand would return early and leave the band invisible.
    it(`idle repaint after resume materializes owed rows — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      internals.repaint();
      c.suspendInput();
      c.commitAbove('BLOCK-SUSPENDED\n');
      c.resumeInput();
      labels.push('BLOCK-A', 'BLOCK-B', 'BLOCK-SUSPENDED');
      // resumeInput() calls repaint() internally; no explicit repaint needed.
      assertCommittedOnce(vs, internals.frameTop(), labels, `${s.name} (idle)`);
      c.disarm();
    });

    // Regression #2382 defect 1+2: endTurn after resume. Ensures the full
    // flush path (suspend → commit → resume → repaint → endTurn → disarm) is
    // duplication-free, exercising erasedFramePriorBandErase + owesRows together.
    it(`endTurn after resume: each block appears exactly once — ${s.name}`, async () => {
      const { c, vs } = await makeRig(s);
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        (c as any).repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      (c as any).repaint();
      c.suspendInput();
      c.commitAbove('BLOCK-SUSPENDED\n');
      c.resumeInput();
      labels.push('BLOCK-A', 'BLOCK-B', 'BLOCK-SUSPENDED');
      c.endTurn();
      c.disarm();
      assertEachExactlyOnce(vs, labels, `${s.name} (endTurn-after-resume)`);
    });

    // Regression #2382 overflow: a commit taller than the viewport while
    // suspended uses the band-hold overflow path. All rows must appear exactly
    // once after resume (overflow rows to scrollback, remaining rows to viewport).
    it(`overflow commit while suspended: all rows appear exactly once — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      c.setSpinner({ enabled: true });
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      c.suspendInput();
      const bigLabels: string[] = [];
      for (let i = 0; i < ROWS + 5; i++) bigLabels.push(`BIG-${String(i).padStart(2, '0')}`);
      c.commitAbove(bigLabels.join('\n') + '\n');
      c.resumeInput();
      labels.push('BLOCK-A', 'BLOCK-B', ...bigLabels);
      assertEachExactlyOnce(vs, labels, `${s.name} (overflow)`);
      c.disarm();
    });

    // Non-scrolling external write during suspension: the owner writes a prompt
    // without a trailing newline, so the cursor moves but no scroll occurs. The
    // compositor observes R==P (cursor at same row) and takes the no-write resume
    // path: band model preserved, repaint re-establishes the frame at the exact
    // pre-suspend position. All labels must appear contiguously once.
    // Invariant (Codex P2 limit): if the external write causes a terminal scroll
    // (e.g., `answer\r\n`), committed rows may enter native scrollback while the
    // model still marks them pending. The compositor cannot observe external
    // scrolls, so it cannot prevent the duplicate in that case. Callers that must
    // guarantee no duplicate after a scroll-causing external write must not commit
    // during suspension, or must clear the band via clearCommittedBand() before
    // resumeInput(). The test below uses a non-scrolling write only.
    it(`non-scrolling external write during suspension: no duplicate — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      const stdout = (c as any).stdout as NodeJS.WriteStream;
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      internals.repaint();
      c.suspendInput();
      // Non-scrolling external write: moves cursor but does not emit \n.
      stdout.write('PROMPT? ');
      c.commitAbove('BLOCK-SUSPENDED\n');
      c.resumeInput();
      labels.push('BLOCK-A', 'BLOCK-B', 'BLOCK-SUSPENDED');
      assertCommittedOnce(vs, internals.frameTop(), labels, `${s.name} (ext-write)`);
      c.disarm();
    });

    it(`suspended commit is shown exactly once after resume — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      c.setSpinner({ enabled: true });
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      labels.push('BLOCK-A', 'BLOCK-B');
      // Premise: the scenario really is in the mode it names.
      if (s.contentHug && s.fill === 0) expect(internals.hugSlackProbe()).toBeGreaterThan(0);
      if (s.contentHug && s.fill > 0) expect(internals.hugSlackProbe()).toBe(0);

      c.suspendInput();
      c.commitAbove('BLOCK-SUSPENDED\n');
      labels.push('BLOCK-SUSPENDED');
      c.resumeInput();
      c.commitAbove('BLOCK-C\n');
      labels.push('BLOCK-C');
      c.setSpinner({ enabled: false });
      internals.repaint();

      assertCommittedOnce(vs, internals.frameTop(), labels, s.name);
      c.disarm();
    });

    it(`suspended commit is visible on resume, before any later commit — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      c.setSpinner({ enabled: true });
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        (c as any).repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      c.suspendInput();
      c.commitAbove('BLOCK-SUSPENDED\n');
      c.resumeInput();
      labels.push('BLOCK-A', 'BLOCK-B', 'BLOCK-SUSPENDED');

      assertCommittedOnce(vs, internals.frameTop(), labels, `${s.name} (on resume)`);
      c.disarm();
    });

    // Counted-handoff (issue #2382, PR #2400): no-write suspend/resume — the
    // owner writes nothing; the compositor takes the R==P, S==0 path. The viewport
    // must be byte-identical to what it was immediately before suspendInput() —
    // no blank rows introduced, no content lost.
    it(`no-write suspend/resume: viewport identical before/after — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      c.setSpinner({ enabled: true });
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      labels.push('BLOCK-A', 'BLOCK-B');
      internals.repaint();

      // Snapshot viewport immediately before suspend.
      const viewportBefore = vs.visibleLines().slice();
      const dump = dumpScreen(vs);

      c.suspendInput();
      // Owner writes nothing.
      c.resumeInput();

      const viewportAfter = vs.visibleLines();
      for (let i = 0; i < ROWS; i++) {
        expect(
          viewportAfter[i],
          `[${s.name} (no-write)] row ${i + 1} changed after no-write resume:\nbefore:\n${dump}\nafter:\n${dumpScreen(vs)}`,
        ).toBe(viewportBefore[i]);
      }
      // Blocks must still appear exactly once in the correct order.
      assertCommittedOnce(vs, internals.frameTop(), labels, `${s.name} (no-write resume)`);
      c.disarm();
    });

    // Counted-handoff: owner writes 2 newline-terminated lines that fit within the
    // viewport (non-scrolling: R moves to P+2 but S==0), no queued commits. After
    // resume the compositor takes the owner-wrote path (R != P), forgets the band,
    // advances the anchor to R+1, and repaints. The owner's 2 lines are visible
    // exactly once below the prior block content; nothing is overwritten.
    it(`inline owner write (non-scrolling), no queue: owner lines visible once — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      const stdout = (c as any).stdout as NodeJS.WriteStream;
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      labels.push('BLOCK-A', 'BLOCK-B');
      internals.repaint();

      c.suspendInput();
      // Two CR+LF-terminated owner writes: each advances cursor row by 1.
      // CR resets column to 0, LF advances row. Together they move R from P to
      // P+2. The viewport is large enough that no scroll occurs (S==0), so the
      // observer reports R=P+2, S=0. The compositor takes the owner-wrote path.
      stdout.write('OWNER-LINE-0\r\n');
      stdout.write('OWNER-LINE-1\r\n');
      // No commitAbove while suspended.
      c.resumeInput();

      const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
      const dump = dumpScreen(vs);
      // Prior blocks must each appear exactly once.
      for (const label of labels) {
        const count = all.filter((l) => l.trim() === label).length;
        expect(count, `[${s.name} (owner-write-no-queue)] "${label}" must appear exactly once (found ${count}):\n${dump}`).toBe(1);
      }
      // Owner lines must each appear exactly once.
      const ol0 = all.filter((l) => l.trim() === 'OWNER-LINE-0').length;
      const ol1 = all.filter((l) => l.trim() === 'OWNER-LINE-1').length;
      expect(ol0, `[${s.name} (owner-write-no-queue)] OWNER-LINE-0 must appear exactly once (found ${ol0}):\n${dump}`).toBe(1);
      expect(ol1, `[${s.name} (owner-write-no-queue)] OWNER-LINE-1 must appear exactly once (found ${ol1}):\n${dump}`).toBe(1);
      // Prior blocks must precede the owner lines (blocks appear above owner output).
      const lastBlockIdx = Math.max(...labels.map((lb) => all.findIndex((l) => l.trim() === lb)));
      const ownerIdx = all.findIndex((l) => l.trim() === 'OWNER-LINE-0');
      expect(
        lastBlockIdx < ownerIdx,
        `[${s.name} (owner-write-no-queue)] prior blocks must precede owner lines:\n${dump}`,
      ).toBe(true);
      c.disarm();
    });

    // Counted-handoff: owner writes 2 newline-terminated non-scrolling lines AND
    // a commit is queued while suspended. After resume: order must be blocks, owner
    // lines, queued commit, then the frame — in top-to-bottom order.
    it(`inline owner write + queued commit: order = blocks, owner, commit, frame — ${s.name}`, async () => {
      const { c, vs, internals } = await makeRig(s);
      const stdout = (c as any).stdout as NodeJS.WriteStream;
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        internals.repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      labels.push('BLOCK-A', 'BLOCK-B');
      internals.repaint();

      c.suspendInput();
      // Two CR+LF-terminated owner writes (non-scrolling: S==0, R = P+2).
      stdout.write('OWNER-OUT-A\r\n');
      stdout.write('OWNER-OUT-B\r\n');
      // Queue a commit while the owner holds the TTY.
      c.commitAbove('QUEUED-COMMIT\n');
      c.resumeInput();

      const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
      const dump = dumpScreen(vs);
      // Prior blocks appear exactly once.
      for (const label of labels) {
        const count = all.filter((l) => l.trim() === label).length;
        expect(count, `[${s.name} (owner-write-queue)] "${label}" must appear once (found ${count}):\n${dump}`).toBe(1);
      }
      // Owner lines must each appear exactly once.
      const oaCount = all.filter((l) => l.trim() === 'OWNER-OUT-A').length;
      const obCount = all.filter((l) => l.trim() === 'OWNER-OUT-B').length;
      expect(oaCount, `[${s.name} (owner-write-queue)] OWNER-OUT-A must appear once (found ${oaCount}):\n${dump}`).toBe(1);
      expect(obCount, `[${s.name} (owner-write-queue)] OWNER-OUT-B must appear once (found ${obCount}):\n${dump}`).toBe(1);
      // Queued commit must appear exactly once.
      const qCount = all.filter((l) => l.trim() === 'QUEUED-COMMIT').length;
      expect(qCount, `[${s.name} (owner-write-queue)] QUEUED-COMMIT must appear once (found ${qCount}):\n${dump}`).toBe(1);
      // Order: prior blocks → owner lines → queued commit.
      const lastBlockIdx = Math.max(...labels.map((lb) => all.findIndex((l) => l.trim() === lb)));
      const ownerIdx = all.findIndex((l) => l.trim() === 'OWNER-OUT-A');
      const qIdx = all.findIndex((l) => l.trim() === 'QUEUED-COMMIT');
      expect(lastBlockIdx < ownerIdx, `[${s.name} (owner-write-queue)] blocks must precede owner lines:\n${dump}`).toBe(true);
      expect(ownerIdx < qIdx, `[${s.name} (owner-write-queue)] owner lines must precede queued commit:\n${dump}`).toBe(true);
      c.disarm();
    });

    // Counted-handoff: owner writes enough newline-terminated lines to cause
    // terminal scroll (S>0). The compositor forgets the band model and advances
    // the anchor. After resume every prior block and every SCROLL-LINE-* must
    // appear exactly once across scrollback + viewport (no missing, no duplicate).
    it(`owner scrolls (S>0): all content appears exactly once, in order — ${s.name}`, async () => {
      const { c, vs, internals: _ } = await makeRig(s);
      const stdout = (c as any).stdout as NodeJS.WriteStream;
      const labels: string[] = [];
      for (let i = 0; i < s.fill; i++) {
        const label = `FILL-${String(i).padStart(2, '0')}`;
        labels.push(label);
        c.commitAbove(`${label}\n`);
        (c as any).repaint();
      }
      c.commitAbove('BLOCK-A\n');
      c.commitAbove('BLOCK-B\n');
      labels.push('BLOCK-A', 'BLOCK-B');
      (c as any).repaint();

      c.suspendInput();
      // Write enough CR+LF-terminated lines to scroll ≥3 rows (S >= 3).
      // CR resets the column to 0 before LF so each label starts at column 1,
      // avoiding the soft-wrap indent the VirtualScreen would see with LF-only.
      const scrollLabels: string[] = [];
      for (let i = 0; i < ROWS + 3; i++) {
        const sl = `SC-${String(i).padStart(3, '0')}`;
        scrollLabels.push(sl);
        stdout.write(`${sl}\r\n`);
      }
      c.commitAbove('QUEUED-S\n');
      c.resumeInput();

      const all = [...vs.scrollbackLines(), ...vs.visibleLines()];
      const dump = dumpScreen(vs);
      // Every prior block must appear exactly once.
      for (const label of labels) {
        const count = all.filter((l) => l.trim() === label).length;
        expect(count, `[${s.name} (scroll)] "${label}" must appear exactly once (found ${count}):\n${dump}`).toBe(1);
      }
      // QUEUED-S must appear exactly once.
      const qCount = all.filter((l) => l.trim() === 'QUEUED-S').length;
      expect(qCount, `[${s.name} (scroll)] QUEUED-S must appear exactly once (found ${qCount}):\n${dump}`).toBe(1);
      // All SCROLL-LINE-* rows must each appear exactly once.
      for (const sl of scrollLabels) {
        const count = all.filter((l) => l.trim() === sl).length;
        expect(count, `[${s.name} (scroll)] "${sl}" must appear exactly once (found ${count}):\n${dump}`).toBe(1);
      }
      c.disarm();
    });
  }
});
