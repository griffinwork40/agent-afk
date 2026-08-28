/**
 * Tests for previewDiff — pre-execution diff preview render component.
 */
import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { previewDiff } from './preview-diff.js';
import type { DiffPayload } from '../../utils/diff.js';

const samplePayload: DiffPayload = {
  addedLines: 1,
  removedLines: 1,
  hunks: [{
    oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: [{ kind: '-', text: 'old line' }, { kind: '+', text: 'new line' }],
  }],
};

describe('previewDiff', () => {
  it('(a) contains ⟳ Proposed label', () => {
    const out = previewDiff(samplePayload);
    expect(out).toContain('⟳ Proposed');
  });

  it('(b) contains hunk content (after strip-ansi)', () => {
    const out = stripAnsi(previewDiff(samplePayload));
    expect(out).toContain('old line');
    expect(out).toContain('new line');
  });

  it('(c) maxLines propagation truncates long diffs', () => {
    const manyLines: DiffPayload = {
      addedLines: 5,
      removedLines: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: 5,
        lines: Array.from({ length: 5 }, (_, i) => ({ kind: '+' as const, text: `line ${i}` })),
      }],
    };
    const out = stripAnsi(previewDiff(manyLines, { maxLines: 2 }));
    expect(out).toContain('⟳ Proposed');
    // Only 2 body lines rendered; the rest elided
    const bodyLines = out.split('\n').filter(l => l.includes('+ line'));
    expect(bodyLines.length).toBeLessThanOrEqual(2);
  });

  it('(d) accepts optional filePath in stat header', () => {
    const out = stripAnsi(previewDiff(samplePayload, { filePath: 'src/foo.ts' }));
    expect(out).toContain('src/foo.ts');
  });

  it('returns a string (type check)', () => {
    expect(typeof previewDiff(samplePayload)).toBe('string');
  });
});
