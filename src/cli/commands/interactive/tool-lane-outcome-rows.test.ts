import { describe, it, expect } from 'vitest';
import { stripAnsi, displayWidth } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import { fitLabelAndOutcome, outcomeTailWidth, pushOutcomeRows } from './tool-lane-outcome-rows.js';
import { formatGroupedToolResults } from './tool-lane-render-grouped-root.js';
import { freshToolEntry } from './tool-lane-render.js';

// The exact shape from the bug report: a long bash command that fails with a
// two-line error. Before the fix, the body rows were clipped to the 20-column
// floor (`fatal: Needed a sin…`) and the head clamp dropped `— ✗ … exit 128`.
const LONG_CMD =
  '▸ bash git fetch -q origin main && git rev-parse --short HEAD origin/main && git status --short && git log --oneline -3';

function failedBash(): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 't1',
    isError: true,
    exitCode: 128,
    content: 'Command exited with code 128\nfatal: Needed a single revision',
    lineCount: 2,
    tailPreview: ['Command exited with code 128', 'fatal: Needed a single revision'],
  };
}

function render(cols: number): string[] {
  const lines: string[] = [];
  pushOutcomeRows(lines, { lead: '   ', label: LONG_CMD, sep: ' — ✗ ' }, failedBash(), {
    continuationIndent: '   ',
    cols,
  });
  return lines.map(stripAnsi);
}

describe('pushOutcomeRows', () => {
  it.each([120, 80, 60])('shows full error lines and keeps the status at %i cols', (cols) => {
    const [head, ...body] = render(cols);
    expect(head).toContain('— ✗ 2 lines · exit 128');
    expect(body).toEqual(['   ▌   Command exited with code 128', '   ▌   fatal: Needed a single revision']);
  });

  it('shrinks the label, never the status, and never exceeds cols', () => {
    for (const cols of [40, 60, 120]) {
      for (const line of render(cols)) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
    }
    const [head] = render(60);
    expect(head).toMatch(/^ {3}▸ bash git fetch.*… — ✗ 2 lines · exit 128$/u);
  });

  it('leaves a row untouched when everything fits', () => {
    const lines: string[] = [];
    pushOutcomeRows(lines, { lead: '   ', label: '▸ bash ls', sep: ' — ✓ ' }, {
      type: 'tool_result', toolUseId: 't', content: 'ok', isError: false,
    }, { continuationIndent: '   ', cols: 120 });
    expect(lines.map(stripAnsi)).toEqual(['   ▸ bash ls — ✓ ok']);
  });
});

describe('outcomeTailWidth', () => {
  it('is the row minus indent and gutter, independent of the head line', () => {
    expect(outcomeTailWidth(120, '   ')).toBe(113);
    expect(outcomeTailWidth(10, '   ')).toBe(20);
  });
});

describe('fitLabelAndOutcome', () => {
  it('gives a short outcome its full width and truncates the label', () => {
    const [label, outcome] = fitLabelAndOutcome('x'.repeat(50), 'exit 1', 30);
    expect(outcome).toBe('exit 1');
    expect(displayWidth(label)).toBe(24);
  });

  it('splits evenly when both sides are long', () => {
    const [label, outcome] = fitLabelAndOutcome('a'.repeat(50), 'b'.repeat(50), 40);
    expect(displayWidth(label)).toBe(20);
    expect(displayWidth(outcome)).toBe(20);
  });
});

/**
 * Regression: `groupedResultSuffix` called `formatOutcome` without `tailWidth`,
 * so tail-preview lines were formatted with the 60-column `maxPreview` fallback
 * instead of the actual terminal width (#2688). The visible effect: entries with
 * `hiddenLineCount > 0` or long `tailPreview` rendered the continuation budget
 * against the wrong constant before the join stripped them to `…`.
 */
describe('formatGroupedToolResults — tailWidth plumbed through groupedResultSuffix (#2688)', () => {
  function makeEntry(content: string, extra?: Partial<ToolResultChunk>) {
    const entry = freshToolEntry('u1', 'bash', 'cmd', '▸ bash cmd');
    entry.result = { type: 'tool_result', toolUseId: 'u1', content, isError: false, ...extra };
    return entry;
  }

  it('row fits within cols when entries have hiddenLineCount > 0 and tailPreview', () => {
    const entries = [
      makeEntry('', { lineCount: 200, hiddenLineCount: 193, tailPreview: ['x'.repeat(100)] }),
      makeEntry('', { lineCount: 50 }),
    ];
    for (const cols of [60, 80, 120, 160]) {
      const row = stripAnsi(formatGroupedToolResults('bash', entries, cols));
      expect(displayWidth(row), `row exceeds ${cols} cols`).toBeLessThanOrEqual(cols);
    }
  });

  it('multi-line outcome is collapsed to "…" in the grouped suffix', () => {
    // When formatOutcome returns a multi-line string (hiddenLineCount adds a \n),
    // groupedResultSuffix strips the continuation. The row must show "…" for that
    // entry's outcome, not raw newlines or truncated internal budget artifacts.
    const entries = [
      makeEntry('', { lineCount: 80, hiddenLineCount: 73, tailPreview: ['last line'] }),
      makeEntry('ok text'),
    ];
    const row = stripAnsi(formatGroupedToolResults('bash', entries, 120));
    expect(row).toContain('…');
  });
});
