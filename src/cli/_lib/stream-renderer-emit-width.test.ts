/**
 * Regression tests for emitMarkdown width-capping.
 *
 * emitMarkdown is the fallback render path used when a `message` event arrives
 * with no active streaming renderer (cached/non-incremental responses) and on
 * non-TTY surfaces. It previously called renderMarkdownToTerminal(text) with no
 * maxWidth, so wide tables rendered at their natural width and overflowed past
 * the right edge on any terminal narrower than the table (and never reflowed on
 * resize, because the lines are already committed to scrollback). These tests
 * lock the fix: on a TTY the output is capped to the visible content width;
 * piped/non-TTY output stays full-width.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { emitMarkdown } from './stream-renderer-orchestrator-emit.js';
import { displayWidth } from '../display.js';
import type { Writer } from '../slash/types.js';

function captureWriter(): { lines: string[]; out: Writer } {
  const lines: string[] = [];
  const out: Writer = {
    line: (text = '') => lines.push(text),
    raw: (text) => lines.push(text),
    success: (text) => lines.push(text),
    info: (text) => lines.push(text),
    warn: (text) => lines.push(text),
    error: (text) => lines.push(text),
  };
  return { lines, out };
}

const WIDE_TABLE = [
  '| Column One Header | Column Two Header | Column Three Header |',
  '| --- | --- | --- |',
  '| alpha value here | beta value here | gamma value here too |',
  '| delta value here | epsilon value here | zeta value here also |',
].join('\n');

describe('emitMarkdown width capping', () => {
  const origColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  afterEach(() => {
    if (origColumns) Object.defineProperty(process.stdout, 'columns', origColumns);
    if (origIsTTY) Object.defineProperty(process.stdout, 'isTTY', origIsTTY);
  });

  function stubTerminal(isTTY: boolean, columns: number): void {
    Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  }

  it('caps every emitted line to the content width on a TTY', () => {
    stubTerminal(true, 40);
    const { lines, out } = captureWriter();
    emitMarkdown(WIDE_TABLE, out);

    expect(lines.length).toBeGreaterThan(0);
    // contentWidth budget is terminal − 2 = 38. No emitted line may exceed it.
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(38);
    }
  });

  it('breaks an over-long bare token instead of overflowing on a TTY', () => {
    stubTerminal(true, 40);
    const { lines, out } = captureWriter();
    emitMarkdown('See https://example.com/' + 'x'.repeat(80), out);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(38);
    }
  });

  it('leaves output full-width off a TTY (piped/redirected)', () => {
    stubTerminal(false, 40);
    const { lines, out } = captureWriter();
    emitMarkdown(WIDE_TABLE, out);

    // Non-TTY preserves the historical behavior: the table renders at its
    // natural width, so at least one row exceeds the 38-col TTY budget.
    expect(lines.some((line) => displayWidth(line) > 38)).toBe(true);
  });
});
