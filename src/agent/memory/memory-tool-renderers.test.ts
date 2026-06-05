/**
 * Tests for memory-tool display formatters.
 *
 * Pure-function tests against fixtures that MIRROR the raw `content`
 * strings the memory handlers in `memory-tools.ts` actually emit on their
 * happy paths. Drift between handler output and these fixtures is the
 * only failure mode this layer introduces; these tests are the drift
 * guard.
 */

import { describe, it, expect } from 'vitest';
import {
  formatMemorySearchDisplay,
  formatMemoryUpdateDisplay,
  formatProcedureWriteDisplay,
} from './memory-tool-renderers.js';

describe('formatMemorySearchDisplay', () => {
  it('"no results" for empty array', () => {
    expect(formatMemorySearchDisplay('[]')).toBe('no results');
  });

  it('counts mixed facts and procedures', () => {
    const content = JSON.stringify([
      { type: 'fact', content: 'a', created_at: '', confidence: 1 },
      { type: 'fact', content: 'b', created_at: '', confidence: 1 },
      { type: 'procedure', content: '# proc', created_at: '', confidence: 1 },
    ]);
    expect(formatMemorySearchDisplay(content)).toBe(
      '3 results (2 facts, 1 procedure)',
    );
  });

  it('singular forms when count is 1', () => {
    const content = JSON.stringify([{ type: 'procedure' }]);
    expect(formatMemorySearchDisplay(content)).toBe('1 result (1 procedure)');
  });

  it('facts-only omits the procedure clause', () => {
    const content = JSON.stringify([{ type: 'fact' }, { type: 'fact' }]);
    expect(formatMemorySearchDisplay(content)).toBe('2 results (2 facts)');
  });

  it('forward-compat: unknown result types collapse to total-only', () => {
    const content = JSON.stringify([{ type: 'fact' }, { type: 'note' }]);
    expect(formatMemorySearchDisplay(content)).toBe('2 results');
  });

  it('returns null on malformed JSON', () => {
    expect(formatMemorySearchDisplay('not json')).toBeNull();
    expect(formatMemorySearchDisplay('{broken')).toBeNull();
  });

  it('returns null when shape is not an array', () => {
    expect(formatMemorySearchDisplay('{}')).toBeNull();
    expect(formatMemorySearchDisplay('null')).toBeNull();
  });
});

describe('formatMemoryUpdateDisplay', () => {
  it('hot/set → "hot memory saved"', () => {
    const content = JSON.stringify({ saved: true, target: 'hot' });
    expect(formatMemoryUpdateDisplay(content)).toBe('hot memory saved');
  });

  it('fact/set → "fact #N set"', () => {
    const content = JSON.stringify({ id: 137, action: 'set', target: 'fact' });
    expect(formatMemoryUpdateDisplay(content)).toBe('fact #137 set');
  });

  it('fact/supersede → "fact #N supersedes #M"', () => {
    const content = JSON.stringify({
      id: 138,
      action: 'supersede',
      target: 'fact',
      supersedes: 99,
    });
    expect(formatMemoryUpdateDisplay(content)).toBe(
      'fact #138 supersedes #99',
    );
  });

  it('fact/remove success → "fact removed"', () => {
    const content = JSON.stringify({
      removed: true,
      action: 'remove',
      target: 'fact',
    });
    expect(formatMemoryUpdateDisplay(content)).toBe('fact removed');
  });

  it('fact/remove miss → "fact not found"', () => {
    const content = JSON.stringify({
      removed: false,
      action: 'remove',
      target: 'fact',
    });
    expect(formatMemoryUpdateDisplay(content)).toBe('fact not found');
  });

  it('hot/remove (hypothetical future shape) is NOT mislabeled as fact/remove', () => {
    // Defensive: every fact-branch gates on target === 'fact', so a future
    // hot-remove shape returns null instead of "fact removed".
    const content = JSON.stringify({
      removed: true,
      action: 'remove',
      target: 'hot',
    });
    expect(formatMemoryUpdateDisplay(content)).toBeNull();
  });

  it('returns null on unrecognized shape', () => {
    expect(formatMemoryUpdateDisplay('{"foo":"bar"}')).toBeNull();
    expect(formatMemoryUpdateDisplay('{}')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(formatMemoryUpdateDisplay('{broken')).toBeNull();
  });
});

describe('formatProcedureWriteDisplay', () => {
  it("returns \"wrote procedure '<name>'\"", () => {
    const content = JSON.stringify({ name: 'telemetry-split', written: true });
    expect(formatProcedureWriteDisplay(content)).toBe(
      "wrote procedure 'telemetry-split'",
    );
  });

  it('returns null when written is not true', () => {
    expect(formatProcedureWriteDisplay('{"name":"x"}')).toBeNull();
    expect(formatProcedureWriteDisplay('{"name":"x","written":false}')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(formatProcedureWriteDisplay('{broken')).toBeNull();
  });
});
