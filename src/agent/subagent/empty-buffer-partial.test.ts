/**
 * Tests for empty-buffer-partial helpers (GitHub issue #724).
 *
 * Verifies that when a subagent stream is cut off with an empty text buffer
 * but prior tool results exist, the helpers produce the correct error and
 * partial output — so the parent can distinguish "died with N gathered
 * results" from "died with nothing gathered".
 */

import { describe, it, expect } from 'vitest';
import { StreamIncompleteError } from '../../utils/errors.js';
import { buildEmptyBufferError, synthesizeEmptyBufferPartial } from './empty-buffer-partial.js';
import type { SubagentToolResult } from './result.js';

// ---------------------------------------------------------------------------
// buildEmptyBufferError
// ---------------------------------------------------------------------------

describe('buildEmptyBufferError', () => {
  it('returns a StreamIncompleteError', () => {
    const err = buildEmptyBufferError('sub-1', []);
    expect(err).toBeInstanceOf(StreamIncompleteError);
  });

  it('no-results path: toolResultsGathered is absent, message mentions "no output"', () => {
    const err = buildEmptyBufferError('sub-1', []);
    expect(err.toolResultsGathered).toBeUndefined();
    expect(err.message).toContain('no output');
  });

  it('with-results path: toolResultsGathered equals the count', () => {
    const results: SubagentToolResult[] = [
      { toolUseId: 'a', sizeBytes: 1000 },
      { toolUseId: 'b', sizeBytes: 2000 },
    ];
    const err = buildEmptyBufferError('sub-2', results);
    expect(err.toolResultsGathered).toBe(2);
    expect(err.message).toContain('2 tool result(s)');
    expect(err.message).toContain('sub-2');
  });

  it('single result: toolResultsGathered is 1', () => {
    const err = buildEmptyBufferError('sub-3', [{ toolUseId: 'x', sizeBytes: 500 }]);
    expect(err.toolResultsGathered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// synthesizeEmptyBufferPartial
// ---------------------------------------------------------------------------

describe('synthesizeEmptyBufferPartial', () => {
  it('returns undefined when there are no tool results', () => {
    expect(synthesizeEmptyBufferPartial('sub-1', [])).toBeUndefined();
  });

  it('returns a string mentioning the count and subagent id', () => {
    const results: SubagentToolResult[] = [
      { toolUseId: 'a', sizeBytes: 1000 },
      { toolUseId: 'b', sizeBytes: 2000 },
      { toolUseId: 'c', sizeBytes: 500 },
    ];
    const out = synthesizeEmptyBufferPartial('sub-2', results);
    expect(out).toBeTypeOf('string');
    expect(out).toContain('sub-2');
    expect(out).toContain('3 tool result(s)');
    expect(out).toContain('3500'); // total bytes
  });

  it('includes error count when some results errored', () => {
    const results: SubagentToolResult[] = [
      { toolUseId: 'a', isError: true, sizeBytes: 100 },
      { toolUseId: 'b', sizeBytes: 200 },
    ];
    const out = synthesizeEmptyBufferPartial('sub-3', results);
    expect(out).toContain('1 errored');
  });

  it('omits error suffix when no results errored', () => {
    const results: SubagentToolResult[] = [
      { toolUseId: 'a', sizeBytes: 100 },
    ];
    const out = synthesizeEmptyBufferPartial('sub-4', results);
    expect(out).not.toContain('errored');
  });

  it('treats missing sizeBytes as 0 when summing total bytes', () => {
    const results: SubagentToolResult[] = [
      { toolUseId: 'a' },          // no sizeBytes
      { toolUseId: 'b', sizeBytes: 500 },
    ];
    const out = synthesizeEmptyBufferPartial('sub-5', results);
    expect(out).toContain('500');  // 0 + 500
  });
});
