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
