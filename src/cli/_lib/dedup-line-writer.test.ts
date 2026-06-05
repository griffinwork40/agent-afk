/**
 * Tests for the consecutive-identical-line collapsing writer used as
 * defense-in-depth in capture-mode paths. See dedup-line-writer.ts for
 * the rationale.
 */

import { describe, it, expect } from 'vitest';
import { makeDedupingLineWriter } from './dedup-line-writer.js';
import type { Writer } from '../slash/types.js';

function makeArrayWriter(): { writer: Writer; lines: string[] } {
  const lines: string[] = [];
  const writer: Writer = {
    line(text?: string): void {
      lines.push(text ?? '');
    },
    raw(text: string): void {
      lines.push(`<raw>${text}`);
    },
    success(text: string): void {
      lines.push(`<ok>${text}`);
    },
    info(text: string): void {
      lines.push(`<info>${text}`);
    },
    warn(text: string): void {
      lines.push(`<warn>${text}`);
    },
    error(text: string): void {
      lines.push(`<err>${text}`);
    },
  };
  return { writer, lines };
}

describe('makeDedupingLineWriter', () => {
  it('passes through up to maxRepeat identical lines unchanged', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 2);
    d.line('hello');
    d.line('hello');
    d.flush();
    expect(lines).toEqual(['hello', 'hello']);
  });

  it('collapses runs longer than maxRepeat with a summary line', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 2);
    for (let i = 0; i < 16; i++) d.line('+ @tailwind components;');
    d.line('+ next line');
    // 2 raw emissions + summary + the divergent line = 4 lines total.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('+ @tailwind components;');
    expect(lines[1]).toBe('+ @tailwind components;');
    expect(lines[2]).toMatch(/repeated 14 more times/);
    expect(lines[3]).toBe('+ next line');
  });

  it('emits singular "1 more time" without trailing s', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 1);
    d.line('x');
    d.line('x');
    d.flush();
    expect(lines[0]).toBe('x');
    // The summary line is `  … (line repeated 1 more time)` — ends with `)`,
    // and we want to assert the singular form (no trailing 's' on "time").
    expect(lines[1]).toMatch(/repeated 1 more time\)$/);
  });

  it('flush() finalizes a trailing run even with no divergent line', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 2);
    for (let i = 0; i < 5; i++) d.line('same');
    d.flush();
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2)).toEqual(['same', 'same']);
    expect(lines[2]).toMatch(/repeated 3 more times/);
  });

  it('flush() is idempotent', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 2);
    d.line('a');
    d.line('a');
    d.line('a');
    d.flush();
    d.flush();
    d.flush();
    expect(lines.filter((l) => l.includes('repeated'))).toHaveLength(1);
  });

  it('runs of size ≤ maxRepeat emit nothing extra', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 2);
    d.line('x');
    d.line('x');
    d.line('y');
    d.flush();
    // No summary expected — the run never exceeded the cap.
    expect(lines).toEqual(['x', 'x', 'y']);
  });

  it('treats undefined-line and empty-line as the same value', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 2);
    d.line(undefined);
    d.line('');
    d.line(undefined);
    d.line('');
    d.flush();
    // 2 pass through + 1 summary line for the suppressed 2 = 3 lines.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/repeated 2 more times/);
  });

  it('non-line channels (raw/success/info/warn/error) bypass dedup and reset run state', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 2);
    d.line('x');
    d.line('x');
    d.line('x');     // run of 3, third should be suppressed
    d.success('done'); // run-boundary: summary should emit before
    d.line('x');     // fresh run — should NOT be considered identical to pre-success
    d.line('x');
    d.line('x');     // run of 3, third suppressed again
    d.flush();

    // Expected:  x, x, summary(1), <ok>done, x, x, summary(1)
    // Summary format: `  … (line repeated 1 more time)` — anchor on the `)`.
    expect(lines).toEqual([
      'x',
      'x',
      expect.stringMatching(/repeated 1 more time\)$/),
      '<ok>done',
      'x',
      'x',
      expect.stringMatching(/repeated 1 more time\)$/),
    ]);
  });

  it('rejects maxRepeat of 0 or negative or non-integer', () => {
    const { writer } = makeArrayWriter();
    expect(() => makeDedupingLineWriter(writer, 0)).toThrow(RangeError);
    expect(() => makeDedupingLineWriter(writer, -1)).toThrow(RangeError);
    expect(() => makeDedupingLineWriter(writer, 1.5)).toThrow(RangeError);
  });

  it('the divergent-line summary is emitted BEFORE the new line (chronological order)', () => {
    const { writer, lines } = makeArrayWriter();
    const d = makeDedupingLineWriter(writer, 2);
    for (let i = 0; i < 10; i++) d.line('A');
    d.line('B');
    // First two A's, then summary (suppressed 8), then B.
    const summaryIdx = lines.findIndex((l) => l.includes('repeated'));
    const bIdx = lines.indexOf('B');
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeLessThan(bIdx);
  });
});
