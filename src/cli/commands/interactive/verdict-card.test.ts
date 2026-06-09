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
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('✓ Done');
    expect(out).toContain('done');
    expect(out).toContain('shipped feature X');
    expect(out).toContain('evidence');
    expect(out).toContain('tests pass');
    expect(out).toContain('Objective satisfied');
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
    expect(out).toContain('External dependency');
  });

  it('asking: shows the question and the "waiting on you" affordance', () => {
    const state: TerminalState = {
      kind: 'asking',
      question: 'which branch?',
      rawBody: '',
    };
    const out = stripAnsi(renderVerdictCard(state));
    expect(out).toContain('? Asking');
    expect(out).toContain('which branch?');
    expect(out).toContain('Waiting on you');
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

  // ── Item #9: synthesized one-line fallback ────────────────────────────────
  //
  // When no structured rows are parsed, the card should display ONLY the first
  // non-empty line of rawBody — not all prose lines. This keeps the card
  // compact when the model wrote a paragraph as its verdict body.
  it('shows only the first non-empty rawBody line when no labelled fields are present (Item #9)', () => {
    const state: TerminalState = {
      kind: 'done',
      rawBody: [
        'This is the first line of the verdict.',
        'This is the second line with more detail.',
        'And a third line for good measure.',
      ].join('\n'),
    };
    const out = stripAnsi(renderVerdictCard(state));

    // First line present.
    expect(out).toContain('This is the first line of the verdict.');
    // Subsequent prose lines must NOT appear in the card — card is a glance
    // surface, not a prose viewer.
    expect(out).not.toContain('second line with more detail');
    expect(out).not.toContain('third line');
  });

  it('ignores leading blank lines when selecting the first rawBody line (Item #9)', () => {
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

    // The first *non-empty* line is used.
    expect(out).toContain('Which database should I use?');
    // The blank/whitespace-only lines and follow-on prose must not appear.
    expect(out).not.toContain('More context about the question');
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
