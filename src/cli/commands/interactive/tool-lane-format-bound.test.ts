/**
 * Regression tests for #2568: a single huge tool-result line (a base64
 * `data:` URI, as in GitHub's 404 page returned by web_scrape) must not make
 * tool-lane formatting expensive. That formatting runs on every overlay render,
 * synchronously on the main event loop, so superlinear cost starved the REPL.
 *
 * The timing bounds are deliberately generous (250ms). The fixed code handles
 * these inputs in well under 5ms; the old O(n^2) regex took seconds (about
 * 4.7s for FIXTURE_LINE). The gap is three orders of magnitude on both sides,
 * so slow CI runners cannot flip the result.
 */

import { describe, it, expect } from 'vitest';
import { capPreviewInput, PREVIEW_INPUT_CAP } from './tool-lane-format-bound.js';
import { formatOutcome, shortenPaths } from './tool-lane-format.js';
import { stripAnsi, displayWidth } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

const SVG_B64 = Buffer.from(
  '<path d="M452.65 225.872C450.101 221.456 438.022 223.246 435.495 218.683"/>'.repeat(1000),
).toString('base64');
/** About 100K chars on one line, shaped like the field trigger. */
const FIXTURE_LINE = `![404 page](data:image/svg+xml;base64,${SVG_B64})`;
const BUDGET_MS = 250;

function timed<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

describe('capPreviewInput', () => {
  it('returns short text unchanged', () => {
    expect(capPreviewInput('hello')).toBe('hello');
    const exact = 'x'.repeat(PREVIEW_INPUT_CAP);
    expect(capPreviewInput(exact)).toBe(exact);
  });

  it('cuts long text to the cap and marks the cut with an ellipsis', () => {
    const out = capPreviewInput('y'.repeat(PREVIEW_INPUT_CAP + 500));
    expect(out).toBe('y'.repeat(PREVIEW_INPUT_CAP) + '…');
  });

  it('never splits a surrogate pair at the cut point', () => {
    // Place an astral char (2 code units) so its high surrogate sits at the
    // last kept index.
    const text = 'a'.repeat(PREVIEW_INPUT_CAP - 1) + '😀' + 'tail';
    const out = capPreviewInput(text);
    expect(out).toBe('a'.repeat(PREVIEW_INPUT_CAP - 1) + '…');
    expect(out.isWellFormed()).toBe(true);
  });
});

describe('shortenPaths: linear on long scheme-character runs (#2568)', () => {
  it('handles a 100K-char base64 data: URI line within budget', () => {
    const { ms, value } = timed(() => shortenPaths(FIXTURE_LINE));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.startsWith('![404 page](data:image/svg+xml;base64,')).toBe(true);
  });

  it('handles a long run of plain letters within budget', () => {
    const { ms } = timed(() => shortenPaths('a'.repeat(100_000)));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('still keeps URL spans whole, including glued and custom schemes', () => {
    expect(shortenPaths('foohttps://a.b/c/d/e')).toBe('foohttps://a.b/c/d/e');
    expect(shortenPaths('clone git+ssh://git@github.com/o/r.git')).toBe(
      'clone git+ssh://git@github.com/o/r.git',
    );
    expect(shortenPaths('open x-custom.scheme+v2://host/a/b/c')).toBe(
      'open x-custom.scheme+v2://host/a/b/c',
    );
    expect(shortenPaths('curl http://localhost:3000/api/v1/x')).toBe(
      'curl http://localhost:3000/api/v1/x',
    );
  });
});

describe('formatOutcome: bounded cost and width on a huge single-line result (#2568)', () => {
  const base: ToolResultChunk = {
    type: 'tool_result',
    toolUseId: 'unused',
    content: FIXTURE_LINE,
    isError: false,
  };

  it('single-line preview path stays within budget and preview width', () => {
    const { ms, value } = timed(() => formatOutcome(base, undefined, 60, 'web_scrape'));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(displayWidth(stripAnsi(value))).toBeLessThanOrEqual(60);
  });

  it('multi-line tail-preview path stays within budget and preview width', () => {
    const chunk: ToolResultChunk = {
      ...base,
      lineCount: 3,
      tailPreview: ['Find code, projects, and people', FIXTURE_LINE, '[Contact Support](https://support.github.com)'],
    };
    const { ms, value } = timed(() => formatOutcome(chunk, undefined, 60, 'web_scrape'));
    expect(ms).toBeLessThan(BUDGET_MS);
    const lines = stripAnsi(value).split('\n');
    // Headline plus the three tail lines; each tail line is indent + <=60 cols.
    expect(lines).toHaveLength(4);
    for (const line of lines.slice(1)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(4 + 60);
    }
  });

  it('handler-supplied display string is bounded too', () => {
    const { ms } = timed(() => formatOutcome({ ...base, display: FIXTURE_LINE }, undefined, 60, 'web_scrape'));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
