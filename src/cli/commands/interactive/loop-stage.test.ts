/**
 * Tests for the loop-stage tracker.
 *
 * The tracker translates a stream of OutputEvents into one of five stages
 * (Observe / Model / Choose / Act / Update) so the live overlay can show
 * where in AFK's operating loop the agent currently sits. The mapping is
 * deliberately minimal — every stage label must be grounded in an event
 * kind we literally observed, never invented from chat content.
 *
 * These tests pin the event → stage transitions and the multi-tool ordering
 * rule (pendingTools settles before the next stage flip).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createStageTracker,
  resetStageTracker,
  advanceStage,
  formatStageRail,
  LoopStageBar,
  LOOP_STAGES,
  STAGE_LABEL,
} from './loop-stage.js';
import { ResizeBus } from '../../terminal-size.js';
import type { OutputEvent } from '../../../agent/types.js';

function thinkingChunk(content = '...'): OutputEvent {
  return { type: 'chunk', chunk: { type: 'thinking', content } };
}
function contentChunk(content = 'hello'): OutputEvent {
  return { type: 'chunk', chunk: { type: 'content', content } };
}
function toolUse(toolUseId: string, toolName = 'Read'): OutputEvent {
  return {
    type: 'chunk',
    chunk: { type: 'tool_use_detail', toolUseId, toolName, toolInput: '("foo")' },
  };
}
function toolResult(toolUseId: string, content = 'ok'): OutputEvent {
  return { type: 'chunk', chunk: { type: 'tool_result', toolUseId, content } };
}

describe('createStageTracker', () => {
  it('starts in "observing"', () => {
    expect(createStageTracker().stage).toBe('observing');
  });
});

describe('advanceStage — single-tool turn', () => {
  it('observing → modeling on first thinking chunk', () => {
    const s = createStageTracker();
    expect(advanceStage(s, thinkingChunk())).toBe(true);
    expect(s.stage).toBe('modeling');
  });

  it('modeling → acting on tool_use_detail', () => {
    const s = createStageTracker();
    advanceStage(s, thinkingChunk());
    expect(advanceStage(s, toolUse('t1'))).toBe(true);
    expect(s.stage).toBe('acting');
  });

  it('acting → updating on tool_result with no remaining pending tools', () => {
    const s = createStageTracker();
    advanceStage(s, toolUse('t1'));
    advanceStage(s, toolResult('t1'));
    expect(s.stage).toBe('updating');
  });

  it('updating → choosing when content streams afterward', () => {
    const s = createStageTracker();
    advanceStage(s, toolUse('t1'));
    advanceStage(s, toolResult('t1'));
    advanceStage(s, contentChunk());
    expect(s.stage).toBe('choosing');
  });
});

describe('advanceStage — multi-tool turn', () => {
  it('stays in "acting" while multiple tools are still pending', () => {
    const s = createStageTracker();
    advanceStage(s, toolUse('t1'));
    advanceStage(s, toolUse('t2'));
    advanceStage(s, toolResult('t1'));
    // t2 still pending, so we must still be acting.
    expect(s.stage).toBe('acting');
    advanceStage(s, toolResult('t2'));
    expect(s.stage).toBe('updating');
  });

  it('does not flip to "modeling" on thinking while a tool is in flight', () => {
    const s = createStageTracker();
    advanceStage(s, toolUse('t1'));
    advanceStage(s, thinkingChunk());
    expect(s.stage).toBe('acting');
  });

  it('does not flip to "choosing" on content while a tool is in flight', () => {
    const s = createStageTracker();
    advanceStage(s, toolUse('t1'));
    advanceStage(s, contentChunk());
    expect(s.stage).toBe('acting');
  });
});

describe('advanceStage — done event', () => {
  it('clears pending tools defensively on done', () => {
    const s = createStageTracker();
    advanceStage(s, toolUse('t1'));
    advanceStage(s, { type: 'done' } as OutputEvent);
    expect(s.pendingTools.size).toBe(0);
  });

  it('returns false (no stage change) when nothing actually changed', () => {
    const s = createStageTracker();
    advanceStage(s, thinkingChunk()); // observing → modeling
    expect(advanceStage(s, thinkingChunk())).toBe(false);
  });
});

describe('resetStageTracker', () => {
  it('returns the tracker to its fresh state', () => {
    const s = createStageTracker();
    advanceStage(s, toolUse('t1'));
    advanceStage(s, contentChunk());
    resetStageTracker(s);
    expect(s.stage).toBe('observing');
    expect(s.pendingTools.size).toBe(0);
  });
});

describe('advanceStage — tool_diff no-op (T4)', () => {
  it('tool_diff chunk leaves stage unchanged', () => {
    const s = createStageTracker();
    // Start in 'acting' (a tool is in flight) and feed a tool_diff chunk.
    advanceStage(s, toolUse('t1'));
    expect(s.stage).toBe('acting');

    const stageBefore = s.stage;
    const pendingBefore = new Set(s.pendingTools);

    // tool_diff must not change stage.
    const changed = advanceStage(s, {
      type: 'chunk',
      chunk: {
        type: 'tool_diff',
        toolUseId: 't1',
        diff: {
          hunks: [],
          addedLines: 0,
          removedLines: 0,
        },
      },
    });

    expect(changed).toBe(false);
    expect(s.stage).toBe(stageBefore);
    expect(s.pendingTools.size).toBe(pendingBefore.size);
  });

  it('tool_diff chunk does not alter pendingTools', () => {
    const s = createStageTracker();
    advanceStage(s, toolUse('t1'));
    advanceStage(s, toolUse('t2'));
    const sizeBefore = s.pendingTools.size; // 2

    advanceStage(s, {
      type: 'chunk',
      chunk: {
        type: 'tool_diff',
        toolUseId: 't1',
        diff: { hunks: [], addedLines: 0, removedLines: 0 },
      },
    });

    expect(s.pendingTools.size).toBe(sizeBefore);
    expect(s.pendingTools.has('t1')).toBe(true);
    expect(s.pendingTools.has('t2')).toBe(true);
  });
});

describe('formatStageRail', () => {
  const fmt = {
    dim: (s: string) => `dim<${s}>`,
    accent: (s: string) => `accent<${s}>`,
    bold: (s: string) => `bold<${s}>`,
  };

  it('collapses "observing" (idle/reset) to a single dim "· idle" cell', () => {
    const out = formatStageRail('observing', fmt);
    expect(out).toBe('dim<· idle>');
    // The idle collapse must NOT leak any of the five stage labels.
    for (const stage of LOOP_STAGES) {
      expect(out).not.toContain(STAGE_LABEL[stage]);
    }
  });

  it('marks the active stage with the solid diamond and accent+bold', () => {
    const out = formatStageRail('acting', fmt);
    expect(out).toContain('accent<bold<◆ act>>');
    // Inactives use the hollow diamond + dim.
    expect(out).toContain('dim<◇ observe>');
    expect(out).toContain('dim<◇ update>');
  });

  it('renders the full 5-cell rail (with ◆ on the active cell) for every non-observing stage', () => {
    for (const stage of LOOP_STAGES.filter((s) => s !== 'observing')) {
      const out = formatStageRail(stage, fmt);
      // All five stage labels present — the rail is not collapsed.
      for (const label of Object.values(STAGE_LABEL)) {
        expect(out).toContain(label);
      }
      // Exactly the active stage's cell carries the solid diamond.
      expect(out).toContain(`◆ ${STAGE_LABEL[stage]}`);
      for (const other of LOOP_STAGES.filter((s) => s !== stage)) {
        expect(out).not.toContain(`◆ ${STAGE_LABEL[other]}`);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LoopStageBar — reserved-footer bar
//
// These pin the row-reservation lifecycle and the absolute paint-row math.
// The bar paints OUTSIDE the compositor's scroll region via raw CUP escapes
// (same technique as BackgroundStatusBar), so the safety invariants mirror
// that class: row addresses must stay ≥ 1, and non-TTY surfaces must emit no
// escapes at all.
// ───────────────────────────────────────────────────────────────────────────

function makeMockStream(rows = 24, columns = 80, isTTY = true): NodeJS.WriteStream {
  return { columns, rows, isTTY, write: vi.fn() } as unknown as NodeJS.WriteStream;
}

/** Concatenate every chunk written to the mock stream. */
function joinWrites(stream: NodeJS.WriteStream): string {
  return (stream.write as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => String(c[0]))
    .join('');
}

/** Extract every `\x1b[<row>;1H` CUP row number from a write blob. */
function cupRows(out: string): number[] {
  return [...out.matchAll(/\x1b\[(\d+);1H/g)].map((m) => parseInt(m[1]!, 10));
}

describe('LoopStageBar', () => {
  // Isolate every test from the real process.stdout resize listener: capture
  // the callback the bar registers and hand back a stub unsubscriber. This
  // also lets the resize test drive a repaint without the 150ms debounce.
  let resizeCb: (() => void) | null;
  let resizeUnsub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resizeCb = null;
    resizeUnsub = vi.fn();
    vi.spyOn(ResizeBus, 'subscribe').mockImplementation((fn: () => void) => {
      resizeCb = fn;
      return resizeUnsub;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('start() reserves exactly one row, then paints the idle rail', () => {
    const stream = makeMockStream();
    let extraRows = 0;
    const bar = new LoopStageBar({ getExtraRows: () => extraRows, stream });
    const rowHandler = vi.fn((n: number) => {
      // Mirror repl-loop's accumulator: the bar's row joins the total.
      extraRows = n === 0 ? 0 : 1;
    });
    bar.setRowCountChangeHandler(rowHandler);

    bar.start();

    // Reservation fires BEFORE the first paint so getExtraRows() already
    // accounts for this bar's own row when repaint() computes its position.
    expect(rowHandler).toHaveBeenCalledWith(1);
    const out = joinWrites(stream);
    // rows=24, extraRows=1 → paint at row 23 (immediately above the status row).
    expect(cupRows(out)).toContain(23);
    // Idle paint collapses to the single dim `· idle` cell (formatStageRail
    // special-cases the between-turns 'observing' stage) — no stage labels.
    expect(out).toContain('· idle');
    expect(out).not.toContain('observe');
    bar.stop();
  });

  it('start() is idempotent — a second call does not re-reserve or re-subscribe', () => {
    const stream = makeMockStream();
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);

    bar.start();
    bar.start();

    expect(rowHandler).toHaveBeenCalledTimes(1);
    expect(ResizeBus.subscribe).toHaveBeenCalledTimes(1);
    bar.stop();
  });

  it('repaint(stage) paints the active stage bracketed by cursor save/restore', () => {
    const stream = makeMockStream();
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    bar.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    bar.repaint('acting');

    const out = joinWrites(stream);
    // Save → CUP → clear-line → content → restore, all in one synchronous blob.
    expect(out.startsWith('\x1b[s')).toBe(true);
    expect(out.endsWith('\x1b[u')).toBe(true);
    expect(out).toContain('\x1b[2K');
    expect(out).toContain('\x1b[23;1H');
    // The active stage is rendered with the solid diamond glyph.
    expect(out).toContain('◆ act');
    bar.stop();
  });

  it('sits at the topmost reserved row, above the background-task bar rows', () => {
    // 1 loop-stage row + 2 bg-task rows already reserved → getExtraRows() == 3.
    const stream = makeMockStream(24);
    const bar = new LoopStageBar({ getExtraRows: () => 3, stream });
    bar.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    bar.repaint('modeling');

    // rows=24, extraRows=3 → paintRow = 21. Bg-bar owns 22–23, status owns 24.
    expect(cupRows(joinWrites(stream))).toEqual([21]);
    bar.stop();
  });

  it('clamps the paint row to ≥ 1 when the terminal is shorter than the reservation', () => {
    const stream = makeMockStream(2); // 2-row terminal
    const bar = new LoopStageBar({ getExtraRows: () => 5, stream }); // over-reserved
    bar.start();

    // Math.max(1, 2 - 5) === 1 — never a zero/negative CUP address.
    for (const row of cupRows(joinWrites(stream))) {
      expect(row).toBeGreaterThanOrEqual(1);
    }
    bar.stop();
  });

  it('non-TTY: repaint emits no escape sequences', () => {
    const stream = makeMockStream(24, 80, /* isTTY */ false);
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    bar.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    bar.repaint('acting');

    expect(joinWrites(stream)).toBe('');
    bar.stop();
  });

  it('stop() clears the row, releases the reservation, and is safe to call twice', () => {
    const stream = makeMockStream();
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    bar.stop();

    const out = joinWrites(stream);
    // Clears row 23 (the reserved footer row) and unsubscribes from resize.
    expect(out).toContain('\x1b[23;1H');
    expect(out).toContain('\x1b[2K');
    expect(rowHandler).toHaveBeenLastCalledWith(0);
    expect(resizeUnsub).toHaveBeenCalledTimes(1);

    // Double-stop must not throw or re-fire the release.
    rowHandler.mockClear();
    expect(() => bar.stop()).not.toThrow();
    expect(rowHandler).not.toHaveBeenCalled();
  });

  it('repaints with the new geometry on a terminal resize', () => {
    const stream = makeMockStream(24);
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    bar.start();
    expect(resizeCb).toBeTypeOf('function');
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // SIGWINCH: the terminal shrinks to 10 rows. Node updates stream.rows
    // synchronously before the resize callback runs.
    Object.defineProperty(stream, 'rows', { value: 10, configurable: true });
    resizeCb!();

    // rows=10, extraRows=1 → paint at row 9, not the stale row 23.
    expect(cupRows(joinWrites(stream))).toContain(9);
    bar.stop();
  });
});

describe('LoopStageBar — AFK_PLAIN_OUTPUT full render opt-out', () => {
  // Regression: --plain must make a TTY session behave like a non-TTY surface,
  // so the loop-stage rail reserves no DECSTBM row and paints nothing even
  // though `stream.isTTY` is still true.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reserves no row and paints nothing on a real TTY when AFK_PLAIN_OUTPUT=1', () => {
    vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
    const stream = makeMockStream(); // isTTY: true
    const rowHandler = vi.fn();
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();
    bar.repaint('acting');
    expect(rowHandler).not.toHaveBeenCalled();
    expect(joinWrites(stream)).toBe('');
    bar.stop();
  });

  it('reserves its row and paints on a TTY when AFK_PLAIN_OUTPUT is unset (no behavior change)', () => {
    vi.stubEnv('AFK_PLAIN_OUTPUT', undefined as unknown as string);
    const stream = makeMockStream();
    const rowHandler = vi.fn();
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();
    expect(rowHandler).toHaveBeenCalledWith(1);
    expect(joinWrites(stream)).not.toBe('');
    bar.stop();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LoopStageBar — idle GROW footer ghost (defect 2)
//
// When a tmux pane grows while the compositor is idle (between turns),
// LoopStageBar must erase the old rail row before painting at the new
// (lower) position. Without a ResizeBus.subscribeImmediate snapshot of the
// pre-resize row, the old copy stays on screen as a ghost above the new one.
//
// Fix: LoopStageBar registers a subscribeImmediate callback that snapshots
// `lastPaintedRow` → `preResizePaintedRow`. The debounced subscriber's
// repaint() then erases `preResizePaintedRow` before writing the new row.
//
// Covers:
//   G1 — subscribeImmediate is registered on start() and unregistered on stop().
//   G2 — on GROW, the old rail row is erased (EL+CUP) before the new one is painted.
//   G3 — on SHRINK, no attempt to erase a stale row below the new viewport.
//   G4 — snapshot is cleared after consumption (idempotent across two consecutive GROWs).
// ───────────────────────────────────────────────────────────────────────────

describe('LoopStageBar — idle GROW footer ghost erase', () => {
  let resizeCb: (() => void) | null;
  let resizeImmCb: (() => void) | null;
  let resizeUnsub: ReturnType<typeof vi.fn>;
  let resizeImmUnsub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resizeCb = null;
    resizeImmCb = null;
    resizeUnsub = vi.fn();
    resizeImmUnsub = vi.fn();
    vi.spyOn(ResizeBus, 'subscribe').mockImplementation((fn: () => void) => {
      resizeCb = fn;
      return resizeUnsub;
    });
    vi.spyOn(ResizeBus, 'subscribeImmediate').mockImplementation((fn: () => void) => {
      resizeImmCb = fn;
      return resizeImmUnsub;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('G1: subscribeImmediate is registered on start() and unregistered on stop()', () => {
    const stream = makeMockStream(24, 80);
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    bar.start();
    expect(resizeImmCb, 'subscribeImmediate callback must be registered on start()').not.toBeNull();
    bar.stop();
    expect(resizeImmUnsub, 'subscribeImmediate must be unsubscribed on stop()').toHaveBeenCalledOnce();
  });

  it('G2: on GROW, the old rail row is erased before the new row is painted', () => {
    // pane: 24 rows, extraRows=1 → rail at row 23 initially.
    let rows = 24;
    const stream = {
      columns: 80,
      get rows() { return rows; },
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    let extraRows = 1;
    const bar = new LoopStageBar({ getExtraRows: () => extraRows, stream });
    bar.start();
    // Initial paint at row 23 (24 - 1 = 23).
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // SIGWINCH immediate fires (resize): snapshot the old row.
    // At this point, stream.rows might already reflect new height in a real
    // scenario, but the immediate channel fires synchronously at resize time
    // before any repaint, so lastPaintedRow still holds the OLD position.
    // Simulate by calling the immediate callback now.
    expect(resizeImmCb, 'immediate callback must be registered').not.toBeNull();
    resizeImmCb!();

    // Now simulate the debounced resize callback (GROW: rows 24→50).
    rows = 50;
    // With GROW, extraRows stays at 1. New paint row = 49 (50 - 1 = 49).
    resizeCb!();

    const out = joinWrites(stream);
    const rowsWritten = cupRows(out);

    // The old row (23) must appear in the output as an erase target
    // (CUP to row 23 followed by EL or similar).
    expect(out, 'old rail row 23 must be erased in the resize repaint').toContain('\x1b[23;1H');
    // The erase at row 23 must be followed by a clear-line sequence.
    expect(out, 'old rail row 23 must be cleared (EL)').toMatch(/\x1b\[23;1H\x1b\[2K/);

    // The new rail must be painted at row 49.
    expect(rowsWritten, 'new rail must be painted at row 49').toContain(49);

    bar.stop();
  });

  it('G3: on SHRINK, no stale-row erase for a row outside the new viewport', () => {
    // pane: 50 rows, rail at row 49. Shrink to 24.
    let rows = 50;
    const stream = {
      columns: 80,
      get rows() { return rows; },
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    bar.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // Immediate callback: snapshot row 49.
    resizeImmCb!();

    // Debounced callback fires after SHRINK: rows=24, new rail at row 23.
    rows = 24;
    resizeCb!();

    const out = joinWrites(stream);
    // Row 49 is now OUTSIDE the 24-row viewport. It MUST NOT be addressed
    // (addressing it would scroll the terminal unexpectedly).
    expect(out, 'row 49 must not be addressed after shrink to 24 rows').not.toContain('\x1b[49;1H');
    // New rail must be at row 23.
    expect(cupRows(out), 'new rail must be at row 23').toContain(23);

    bar.stop();
  });

  it('G4: pre-resize snapshot is cleared after consumption (second GROW does not double-erase)', () => {
    let rows = 24;
    const stream = {
      columns: 80,
      get rows() { return rows; },
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    bar.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // First GROW: 24→50, rail moves from 23 to 49.
    resizeImmCb!();
    rows = 50;
    resizeCb!();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // Second GROW: 50→70, rail moves from 49 to 69.
    resizeImmCb!();
    rows = 70;
    resizeCb!();

    const out = joinWrites(stream);
    // Row 23 must NOT appear (snapshot was consumed on first resize).
    expect(out, 'row 23 from first GROW must not appear on second GROW').not.toContain('\x1b[23;1H');
    // Row 49 (previous rail) must be erased.
    expect(out, 'old rail row 49 must be erased on second GROW').toContain('\x1b[49;1H');
    expect(out).toMatch(/\x1b\[49;1H\x1b\[2K/);

    bar.stop();
  });
});
