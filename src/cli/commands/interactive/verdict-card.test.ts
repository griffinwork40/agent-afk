/**
 * Tests for the verdict card and ledger.
 *
 * These tests are content-anchored, not pixel-anchored: we strip ANSI codes
 * and assert that the structural content (chip, labels, values, affordance)
 * is present. Box widths and exact glyph placement are deliberately not
 * pinned because they depend on terminal width.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  renderVerdictCard,
  summarizeVerdict,
  type VerdictMeta,
} from './verdict-card.js';
import { createVerdictLedger } from './verdict-ledger.js';
import type { TerminalState } from './terminal-state.js';
import { displayWidth, stripAnsi as displayStripAnsi } from '../../display.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Run `fn` with `process.stdout.columns` pinned to `cols`, restoring the
 * previous value (even on throw) so test ordering can't pollute geometry
 * assertions. Mirrors the pattern in terminal-size.test.ts.
 */
function withCols<T>(cols: number, fn: () => T): T {
  const prev = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', {
    value: cols,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: prev,
      configurable: true,
    });
  }
}

describe('renderVerdictCard', () => {
  it('done: includes chip glyph and structured rows', () => {
    const state: TerminalState = {
      kind: 'done',
      whatWasDone: 'shipped feature X',
      evidence: 'tests pass',
      whatChanged: 'feature X is available to users',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('✓ Done');
    expect(out).toContain('done');
    expect(out).toContain('shipped feature X');
    expect(out).toContain('evidence');
    expect(out).toContain('tests pass');
    expect(out).toContain('changed');
    expect(out).toContain('feature X is available to users');
    // With evidence present, the derived affordance replaces the static one.
    expect(out).toContain('Review:');
  });

  // Regression: models sometimes emit identical text for the "done" and
  // "deferred" fields, producing a confusing duplicate row in the card.
  it('done: suppresses a deferred row that merely echoes the done field', () => {
    const state: TerminalState = {
      kind: 'done',
      whatWasDone: 'No code changed — this was a design map',
      evidence: 'see runtime-source.ts:86',
      deferred: 'No code changed — this was a design map',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('No code changed — this was a design map');
    expect(out).not.toContain('deferred');
    // A genuinely distinct deferred field is still shown.
    const state2: TerminalState = { ...state, deferred: 'integrate with renderer' };
    const out2 = stripAnsi(renderVerdictCard(state2));
    expect(out2).toContain('deferred');
    expect(out2).toContain('integrate with renderer');
  });

  it('blocked: shows blocker, unblock condition, and a recovery affordance', () => {
    const state: TerminalState = {
      kind: 'blocked',
      whatBlocks: 'API key missing',
      unblockCondition: 'set ANTHROPIC_API_KEY',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('⊘ Blocked');
    expect(out).toContain('blocks');
    expect(out).toContain('API key missing');
    expect(out).toContain('unblock');
    // With unblockCondition present, derived affordance is shown instead of static.
    expect(out).toContain('Unblock:');
    expect(out).toContain('set ANTHROPIC_API_KEY');
  });

  it('asking: shows the question and a context-specific affordance', () => {
    const state: TerminalState = {
      kind: 'asking',
      question: 'which branch?',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('? Asking');
    expect(out).toContain('which branch?');
    // With question present, derived affordance is shown instead of static.
    expect(out).toContain('Answer:');
  });

  it('interrupted: shows resume affordance', () => {
    const state: TerminalState = {
      kind: 'interrupted',
      whatWasInProgress: 'running tests',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('⏸ Interrupted');
    expect(out).toContain('running tests');
    expect(out).toContain('Halted with state preserved');
  });

  it('falls back to rawBody when no labelled fields are present', () => {
    const state: TerminalState = {
      kind: 'done',
      rawBody: 'finished everything',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('finished everything');
  });

  // ── Fallback body rendering ───────────────────────────────────────────────
  //
  // When no structured rows are parsed, the card shows up to 5 non-empty body
  // lines so the verdict card still carries substance. Capped to keep the card
  // from sprawling on long unstructured responses.
  it('shows up to 5 non-empty rawBody lines when no labelled fields are present', () => {
    const state: TerminalState = {
      kind: 'done',
      rawBody: [
        'This is the first line of the verdict.',
        'This is the second line with more detail.',
        'And a third line for good measure.',
      ].join('\n'),
    };
    const out = stripAnsi(renderVerdictCard(state));

    // All three lines present (under the 5-line cap).
    expect(out).toContain('This is the first line of the verdict.');
    expect(out).toContain('second line with more detail');
    expect(out).toContain('third line');
  });

  it('caps fallback body at 5 lines', () => {
    const state: TerminalState = {
      kind: 'done',
      rawBody: Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the body`).join('\n'),
    };
    const out = stripAnsi(renderVerdictCard(state));

    // First 5 present.
    for (let i = 1; i <= 5; i++) {
      expect(out).toContain(`Line ${i} of the body`);
    }
    // Lines 6+ excluded.
    expect(out).not.toContain('Line 6');
    expect(out).not.toContain('Line 7');
    expect(out).not.toContain('Line 8');
  });

  it('ignores leading blank lines when selecting fallback body lines', () => {
    const state: TerminalState = {
      kind: 'asking',
      rawBody: [
        '',
        '  ',
        'Which database should I use?',
        'More context about the question.',
      ].join('\n'),
    };
    const out = stripAnsi(renderVerdictCard(state));

    // Both non-empty lines present.
    expect(out).toContain('Which database should I use?');
    expect(out).toContain('More context about the question');
  });

  it('falls back to "<kind> (no structured fields)" when rawBody is empty (Item #9)', () => {
    const state: TerminalState = {
      kind: 'blocked',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('blocked (no structured fields)');
  });
});

describe('summarizeVerdict', () => {
  it('prefers the primary labelled field', () => {
    const state: TerminalState = {
      kind: 'done',
      whatWasDone: 'shipped',
      evidence: 'tests',
      rawBody: '',
    };
    const out = stripAnsi(summarizeVerdict(state, 80));
    expect(out).toContain('Done');
    expect(out).toContain('shipped');
  });

  it('falls back through candidates and finally rawBody', () => {
    const state: TerminalState = {
      kind: 'asking',
      rawBody: 'which env should I deploy to?',
    };
    const out = stripAnsi(summarizeVerdict(state, 80));
    expect(out).toContain('which env should I deploy to?');
  });
});

describe('createVerdictLedger', () => {
  const mkState = (kind: TerminalState['kind']): TerminalState => ({ kind, rawBody: '' });

  it('renders null when empty', () => {
    expect(createVerdictLedger().render()).toBeNull();
  });

  it('renders a rail containing each pushed kind', () => {
    const ledger = createVerdictLedger();
    ledger.push(mkState('done'));
    ledger.push(mkState('asking'));
    ledger.push(mkState('blocked'));
    const rail = stripAnsi(ledger.render() ?? '');
    expect(rail).toContain('done');
    expect(rail).toContain('asking');
    expect(rail).toContain('blocked');
  });

  it('drops the oldest entry when capacity is exceeded', () => {
    const ledger = createVerdictLedger({ capacity: 3 });
    ledger.push(mkState('done'));
    ledger.push(mkState('blocked'));
    ledger.push(mkState('asking'));
    ledger.push(mkState('interrupted'));
    expect(ledger.entries()).toEqual(['blocked', 'asking', 'interrupted']);
  });

  it('reset() clears the buffer', () => {
    const ledger = createVerdictLedger();
    ledger.push(mkState('done'));
    ledger.reset();
    expect(ledger.render()).toBeNull();
    expect(ledger.entries()).toEqual([]);
  });

  it('renders singular vs plural turn count', () => {
    const ledger = createVerdictLedger();
    ledger.push(mkState('done'));
    expect(stripAnsi(ledger.render() ?? '')).toContain('1 turn');
    ledger.push(mkState('done'));
    expect(stripAnsi(ledger.render() ?? '')).toContain('2 turns');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pinned-footer painter — lifecycle & CUP positioning
// ────────────────────────────────────────────────────────────────────────────

function makeMockStream(rows = 24, cols = 80): NodeJS.WriteStream {
  return {
    columns: cols,
    rows,
    isTTY: true,
    write: vi.fn(),
  } as unknown as NodeJS.WriteStream;
}

/** Collect all writes to the mock stream as a single concatenated string. */
function writtenTo(stream: NodeJS.WriteStream): string {
  return (stream.write as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => String(c[0]))
    .join('');
}

describe('createVerdictLedger — pinned footer painter', () => {
  const mkState = (kind: TerminalState['kind']): TerminalState => ({ kind, rawBody: '' });

  it('start()+push(): fires onRowCountChange(1) and CUP-positions at the correct row', () => {
    // totalRows=10, adjacentRows=0 → verdict row = 10-1-0 = 9
    const stream = makeMockStream(10);
    const ledger = createVerdictLedger();
    const rowHandler = vi.fn();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });

    // No entries yet — rowCount stays 0, no rowHandler call from start.
    expect(rowHandler).not.toHaveBeenCalled();

    ledger.push(mkState('done'));

    expect(rowHandler).toHaveBeenCalledWith(1);
    const writes = writtenTo(stream);
    // CUP to row 9 = totalRows(10) - status(1) - adjacentRows(0) = 9
    expect(writes).toContain('\x1b[9;1H');
    // Must save/restore cursor
    expect(writes).toContain('\x1b[s');
    expect(writes).toContain('\x1b[u');
    // Must erase the line before painting
    expect(writes).toContain('\x1b[2K');

    ledger.stop();
  });

  it('start()+push(): adjacentRows=2 shifts the verdict row upward', () => {
    // totalRows=10, adjacentRows=2 → verdict row = 10-1-2 = 7
    const stream = makeMockStream(10);
    const ledger = createVerdictLedger();
    ledger.start({ stream, getAdjacentRows: () => 2 });
    ledger.push(mkState('blocked'));

    const writes = writtenTo(stream);
    expect(writes).toContain('\x1b[7;1H');
    expect(writes).not.toContain('\x1b[8;1H');
    expect(writes).not.toContain('\x1b[9;1H');

    ledger.stop();
  });

  it('reset(): fires onRowCountChange(0) and clears the row', () => {
    const stream = makeMockStream(10);
    const ledger = createVerdictLedger();
    const rowHandler = vi.fn();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });

    ledger.push(mkState('done'));
    expect(rowHandler).toHaveBeenLastCalledWith(1);

    (stream.write as ReturnType<typeof vi.fn>).mockClear();
    ledger.reset();

    expect(rowHandler).toHaveBeenLastCalledWith(0);
    // A clear sequence must have been emitted
    const writes = writtenTo(stream);
    expect(writes).toContain('\x1b[2K');

    ledger.stop();
  });

  it('stop(): fires onRowCountChange(0) and clears the row', () => {
    const stream = makeMockStream(10);
    const ledger = createVerdictLedger();
    const rowHandler = vi.fn();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });

    ledger.push(mkState('asking'));
    expect(rowHandler).toHaveBeenLastCalledWith(1);

    rowHandler.mockClear();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();
    ledger.stop();

    expect(rowHandler).toHaveBeenCalledWith(0);
    const writes = writtenTo(stream);
    expect(writes).toContain('\x1b[2K');
  });

  it('stop() before any push: does not emit write sequences or fire rowHandler', () => {
    const stream = makeMockStream(10);
    const ledger = createVerdictLedger();
    const rowHandler = vi.fn();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });

    (stream.write as ReturnType<typeof vi.fn>).mockClear();
    ledger.stop();

    // Empty ledger — no row was reserved, so stop should be a no-op on the stream.
    expect(rowHandler).not.toHaveBeenCalled();
    expect((stream.write as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('non-TTY stream: no writes emitted and no rowHandler calls', () => {
    const stream = {
      columns: 80,
      rows: 24,
      isTTY: false,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const ledger = createVerdictLedger();
    const rowHandler = vi.fn();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });

    ledger.push(mkState('done'));
    ledger.reset();
    ledger.stop();

    expect((stream.write as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // rowCount never transitions from 0, so handler never fires
    expect(rowHandler).not.toHaveBeenCalled();
  });

  it('double-start() is a no-op on the second call', () => {
    const stream = makeMockStream(10);
    const ledger = createVerdictLedger();
    const rowHandler = vi.fn();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });
    ledger.start({ stream }); // second start — must be ignored

    ledger.push(mkState('done'));
    // rowHandler called exactly once (not twice from double-start)
    expect(rowHandler).toHaveBeenCalledTimes(1);

    ledger.stop();
  });

  it('double-stop() is a no-op on the second call', () => {
    const stream = makeMockStream(10);
    const ledger = createVerdictLedger();
    const rowHandler = vi.fn();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });

    ledger.push(mkState('interrupted'));
    rowHandler.mockClear();

    ledger.stop();
    ledger.stop(); // second stop — must be ignored

    // Handler fired exactly once (from the first stop)
    expect(rowHandler).toHaveBeenCalledTimes(1);
    expect(rowHandler).toHaveBeenCalledWith(0);
  });

  it('repaint() updates CUP output after push', () => {
    const stream = makeMockStream(10);
    const ledger = createVerdictLedger();
    ledger.start({ stream });

    ledger.push(mkState('done'));
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    ledger.repaint();
    const writes = writtenTo(stream);
    // A re-CUP to the verdict row must be emitted
    expect(writes).toContain('\x1b[9;1H');
  });

  it('rail content is visible in CUP write (smoke test)', () => {
    const stream = makeMockStream(24);
    const ledger = createVerdictLedger();
    ledger.start({ stream });

    ledger.push(mkState('done'));
    ledger.push(mkState('blocked'));

    const writes = writtenTo(stream);
    const plain = writes.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('done');
    expect(plain).toContain('blocked');
    expect(plain).toContain('ledger');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Geometry — regression guard against the off-by-2 width bug.
//
// Pre-fix, the card width was `innerW + 6 = (terminalWidth - 4) + 6 =
// terminalWidth + 2`, so every row overflowed the terminal by 2 columns and
// the terminal wrapped the trailing │/╮/╯ to the next visible row, leaving an
// orphan glyph on each line ("broken bordered box"). These tests pin the
// invariant that every rendered line is ≤ the terminal width and that the
// card geometry is uniform across all rows, so the bug cannot recur silently.
//
// Width is measured via `displayWidth` (string-width), so ANSI styling and
// double-width glyphs in the chip cannot mask a width bug.
// ────────────────────────────────────────────────────────────────────────────

describe('renderVerdictCard geometry', () => {
  // Compact regression fixture: short, structured, ANSI-styled-output safe.
  const shortFixture: TerminalState = {
    kind: 'done',
    whatWasDone: 'shipped feature X',
    evidence: 'tests pass',
    rawBody: '',
  };

  // Long-evidence fixture: forces the wrap path so continuation lines are
  // exercised by the geometry assertions below.
  const wrappingFixture: TerminalState = {
    kind: 'done',
    whatWasDone:
      'Throttled overlay repaints and parked CupFrameRenderer at DECSTBM bottom anchor so commitAbove writes survive multi-line frames.',
    evidence:
      'Added 1500ms throttle on setOverlay (stream-renderer-subagent.ts:318 and 357); verified commit-during-spinner-active no longer erases multi-line frames in the regression test.',
    deferred:
      'Investigate raw child.toolInput newline leak in tool-lane-render.ts:888-892 separately — verified real but lower impact.',
    rawBody: '',
  };

  // Parametric width sweep: 40 (floor case), 60, 80 (default), 100 (cap
  // boundary), 120 (cap engaged). At each width every line must fit and
  // every line must have the same visible width as every other line — i.e.,
  // the borders must align.
  for (const cols of [40, 60, 80, 100, 120]) {
    it(`fits within ${cols} columns and all rows align`, () => {
      withCols(cols, () => {
        const lines = renderVerdictCard(shortFixture).split('\n');
        const widths = lines.map((l) => displayWidth(l));

        // No row may exceed the terminal width (the bug we're guarding).
        for (const [i, w] of widths.entries()) {
          expect(
            w,
            `line ${i} (\`${displayStripAnsi(lines[i] ?? '')}\`) exceeds ${cols} cols at width ${w}`,
          ).toBeLessThanOrEqual(cols);
        }

        // All rows must share the same width — borders aligned.
        expect(new Set(widths).size, `row widths not uniform: ${widths.join(',')}`).toBe(1);

        // Top must close with ╮, bottom with ╯.
        const top = displayStripAnsi(lines[0] ?? '');
        const bot = displayStripAnsi(lines[lines.length - 1] ?? '');
        expect(top.startsWith('╭')).toBe(true);
        expect(top.endsWith('╮')).toBe(true);
        expect(bot.startsWith('╰')).toBe(true);
        expect(bot.endsWith('╯')).toBe(true);
      });
    });
  }

  it('caps card width at the upper bound (innerW=100 → 106 cols) on very wide terminals', () => {
    withCols(200, () => {
      const widths = renderVerdictCard(shortFixture)
        .split('\n')
        .map((l) => displayWidth(l));
      expect(new Set(widths).size).toBe(1);
      // innerW capped at 100 → row width = 100 + 6 = 106.
      expect(widths[0]).toBe(106);
    });
  });

  it('preserves left/right borders on every wrapped continuation line', () => {
    withCols(80, () => {
      const lines = renderVerdictCard(wrappingFixture).split('\n');

      // The fixture must have actually wrapped — otherwise this test is a
      // no-op against future width changes. Baseline without wrapping: top
      // border + blank + 3 fields + blank + affordance + bot border = 8.
      // With three long fields all wrapping at least once, expect ≥ 12.
      expect(lines.length).toBeGreaterThanOrEqual(12);

      for (const [i, line] of lines.entries()) {
        const plain = displayStripAnsi(line);

        // No row may exceed terminal width.
        expect(displayWidth(line), `line ${i} overflows 80 cols`).toBeLessThanOrEqual(80);

        // Every row that contains a │ must be framed by │ on BOTH ends —
        // this is the "left/right borders aligned" invariant the audit
        // identified as silently broken when the card overflows.
        if (plain.includes('│')) {
          expect(plain.startsWith('│'), `line ${i} missing left │: \`${plain}\``).toBe(true);
          expect(plain.endsWith('│'), `line ${i} missing right │: \`${plain}\``).toBe(true);
        }
      }

      // And uniform width across the whole card, including continuation rows.
      const widths = lines.map((l) => displayWidth(l));
      expect(new Set(widths).size, `wrapped rows misalign: ${widths.join(',')}`).toBe(1);
    });
  });

  it.each(['done', 'blocked', 'asking', 'interrupted'] as const)(
    'top border aligns with the %s chip glyph at 80 cols',
    (kind) => {
      withCols(80, () => {
        // Per-kind fixtures so each card actually has structured content
        // (rather than falling through to the rawBody synth path).
        const states: Record<TerminalState['kind'], TerminalState> = {
          done: { kind: 'done', whatWasDone: 'x', rawBody: '' },
          blocked: { kind: 'blocked', whatBlocks: 'x', rawBody: '' },
          asking: { kind: 'asking', question: 'x', rawBody: '' },
          interrupted: { kind: 'interrupted', whatWasInProgress: 'x', rawBody: '' },
        };
        const lines = renderVerdictCard(states[kind]).split('\n');
        const widths = lines.map((l) => displayWidth(l));
        // Whole card uniform AND fits 80 — chip glyph width was subtracted
        // correctly in the top-border dash count.
        expect(new Set(widths).size).toBe(1);
        expect(widths[0]).toBe(80);
      });
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Stats line (VerdictMeta — Improvement #1)
// ────────────────────────────────────────────────────────────────────────────

describe('renderVerdictCard — stats line', () => {
  const baseDone: TerminalState = {
    kind: 'done',
    whatWasDone: 'shipped feature X',
    rawBody: '',
  };

  it('renders cost, duration, and tool count when all meta fields are present', () => {
    const meta: VerdictMeta = { durationMs: 23000, totalCostUsd: 0.42, toolCount: 7 };
    const out = stripAnsi(renderVerdictCard(baseDone, meta));
    expect(out).toContain('$0.42');
    expect(out).toContain('23s');
    expect(out).toContain('7 tool calls');
  });

  it('omits the stats line when no meta is passed (backward compat)', () => {
    const out = stripAnsi(renderVerdictCard(baseDone));
    // No dollar sign, no duration suffix, no "tools" label
    expect(out).not.toMatch(/\$\d/);
    expect(out).not.toMatch(/\d+s/);
    expect(out).not.toContain('tool calls');
  });

  it('omits the stats line when meta is an empty object', () => {
    const out = stripAnsi(renderVerdictCard(baseDone, {}));
    expect(out).not.toMatch(/\$\d/);
    expect(out).not.toMatch(/\d+s/);
    expect(out).not.toContain('tool calls');
  });

  it('renders only cost when only totalCostUsd is provided', () => {
    const out = stripAnsi(renderVerdictCard(baseDone, { totalCostUsd: 1.05 }));
    expect(out).toContain('$1.05');
    expect(out).not.toMatch(/\d+s/);
    expect(out).not.toContain('tool calls');
  });

  it('renders only duration when only durationMs is provided', () => {
    const out = stripAnsi(renderVerdictCard(baseDone, { durationMs: 5000 }));
    expect(out).toContain('5s');
    expect(out).not.toMatch(/\$\d/);
    expect(out).not.toContain('tool calls');
  });

  it('renders only tool count when only toolCount is provided', () => {
    const out = stripAnsi(renderVerdictCard(baseDone, { toolCount: 3 }));
    expect(out).toContain('3 tool calls');
    expect(out).not.toMatch(/\$\d/);
  });

  it('uses singular "tool call" when toolCount is 1', () => {
    const out = stripAnsi(renderVerdictCard(baseDone, { toolCount: 1 }));
    expect(out).toContain('1 tool call');
    expect(out).not.toContain('1 tool calls');
  });

  it('formats duration under a minute as Xs', () => {
    const out = stripAnsi(renderVerdictCard(baseDone, { durationMs: 45000 }));
    expect(out).toContain('45s');
  });

  it('formats duration over a minute as Xm Ys', () => {
    const out = stripAnsi(renderVerdictCard(baseDone, { durationMs: 72000 }));
    expect(out).toContain('1m 12s');
  });

  it('formats exact minute as Xm', () => {
    const out = stripAnsi(renderVerdictCard(baseDone, { durationMs: 300000 }));
    expect(out).toContain('5m');
    // Should not have a spurious "0s" suffix
    expect(out).not.toContain('5m 0s');
  });

  it('card geometry remains uniform when stats line is present', () => {
    withCols(80, () => {
      const meta: VerdictMeta = { durationMs: 23000, totalCostUsd: 0.42, toolCount: 7 };
      const lines = renderVerdictCard(baseDone, meta).split('\n');
      const widths = lines.map((l) => displayWidth(l));
      expect(new Set(widths).size, `row widths not uniform: ${widths.join(',')}`).toBe(1);
      for (const w of widths) {
        expect(w).toBeLessThanOrEqual(80);
      }
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Context-specific affordances (Improvement #2)
// ────────────────────────────────────────────────────────────────────────────

describe('renderVerdictCard — context-specific affordances', () => {
  it('done with evidence: affordance shows "Review: <evidence>"', () => {
    const state: TerminalState = {
      kind: 'done',
      whatWasDone: 'shipped',
      evidence: 'tests pass',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('Review:');
    expect(out).toContain('tests pass');
    // Must not show static fallback when derived affordance is used
    expect(out).not.toContain('Objective satisfied');
  });

  it('done without evidence: falls back to static affordance', () => {
    const state: TerminalState = {
      kind: 'done',
      whatWasDone: 'shipped',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('Objective satisfied');
  });

  it('blocked with unblockCondition: affordance shows "Unblock: <condition>"', () => {
    const state: TerminalState = {
      kind: 'blocked',
      whatBlocks: 'API key missing',
      unblockCondition: 'set ANTHROPIC_API_KEY',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('Unblock:');
    expect(out).toContain('set ANTHROPIC_API_KEY');
    expect(out).not.toContain('External dependency');
  });

  it('blocked without unblockCondition: falls back to static affordance', () => {
    const state: TerminalState = {
      kind: 'blocked',
      whatBlocks: 'API key missing',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('External dependency');
  });

  it('asking with question: affordance shows "Answer: <question>"', () => {
    const state: TerminalState = {
      kind: 'asking',
      question: 'which branch?',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('Answer:');
    expect(out).toContain('which branch?');
    expect(out).not.toContain('Waiting on you');
  });

  it('asking without question: falls back to static affordance', () => {
    const state: TerminalState = {
      kind: 'asking',
      rawBody: 'which branch?',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('Waiting on you');
  });

  it('interrupted: always uses static affordance regardless of fields', () => {
    const state: TerminalState = {
      kind: 'interrupted',
      whatWasInProgress: 'running tests',
      resumeRequires: 'restart CI',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('Halted with state preserved');
    expect(out).not.toContain('Answer:');
    expect(out).not.toContain('Review:');
    expect(out).not.toContain('Unblock:');
  });

  it('long evidence is truncated with "..." in the affordance line', () => {
    withCols(80, () => {
      const state: TerminalState = {
        kind: 'done',
        whatWasDone: 'shipped',
        evidence: 'a'.repeat(200),
        rawBody: '',
      };
      const out = stripAnsi(renderVerdictCard(state));
      expect(out).toContain('Review:');
      expect(out).toContain('...');
      // The affordance line (second-to-last, before the bottom border)
      // must stay within the card width.
      const lines = renderVerdictCard(state).split('\n');
      const affordanceLine = lines[lines.length - 2]!;
      expect(displayWidth(affordanceLine)).toBeLessThanOrEqual(80);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Block-level markdown rendering (tables, code blocks, etc.)
// ────────────────────────────────────────────────────────────────────────────

describe('renderVerdictCard — block-level markdown rendering', () => {
  it('GFM table in evidence field renders with box-drawing chars, not raw pipes', () => {
    const state: TerminalState = {
      kind: 'done',
      whatWasDone: 'Fixed three files',
      evidence: '| File | LOC |\n|------|-----|\n| a.ts | 100 |\n| b.ts | 200 |',
      rawBody: '',
    };
    const card = withCols(120, () => renderVerdictCard(state));
    const plain = stripAnsi(card);
    // The raw GFM pipe-table syntax should NOT appear
    expect(plain).not.toContain('|------|');
    expect(plain).not.toContain('|------');
    // Box-drawing characters from renderTable should appear
    expect(plain).toMatch(/[┌┬┐├┼┤└┴┘│─]/);
    // Table content should still be present
    expect(plain).toContain('a.ts');
    expect(plain).toContain('b.ts');
    expect(plain).toContain('File');
    expect(plain).toContain('LOC');
  });

  it('GFM table in fallback body renders with box-drawing chars', () => {
    const state: TerminalState = {
      kind: 'done',
      rawBody: '| PR | Status |\n|-----|--------|\n| #42 | merged |',
    };
    const card = withCols(120, () => renderVerdictCard(state));
    const plain = stripAnsi(card);
    expect(plain).not.toContain('|-----|');
    expect(plain).toMatch(/[┌┬┐├┼┤└┴┘│─]/);
    expect(plain).toContain('#42');
    expect(plain).toContain('merged');
  });

  it('inline markdown (bold, code) still renders in row values', () => {
    const state: TerminalState = {
      kind: 'done',
      whatWasDone: 'Run `pnpm test` to verify **success**',
      rawBody: '',
    };
    const card = renderVerdictCard(state);
    const plain = stripAnsi(card);
    expect(plain).toContain('pnpm test');
    expect(plain).toContain('success');
    // Raw markdown markers should not appear
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('`pnpm test`');
  });
});
