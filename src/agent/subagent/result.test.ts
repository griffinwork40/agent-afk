/**
 * Tests for SIGNAL block wiring into buildResultFromMessage.
 *
 * Covers the passive-observation contract: `result.signal` is populated from
 * the subagent's final message when a well-formed SIGNAL block is present,
 * and is absent otherwise. Signal extraction is independent of outputSchema
 * presence / validation outcome.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Message } from '../types.js';
import {
  buildResultFromMessage,
  isIncompleteStopReason,
  annotateIfIncomplete,
  incompleteToolResultFields,
  STREAM_INCOMPLETE,
} from './result.js';
import { TOOL_USE_LOOP_CAPPED } from '../providers/shared/tool-loop-cap.js';
import { SOFT_DEADLINE_WIND_DOWN } from '../providers/shared/soft-deadline.js';
import { OVERLOAD_EXHAUSTED } from '../providers/anthropic-direct/overload-pause.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SIGNAL = {
  issue: 'cache-race',
  stance: 'supports' as const,
  confidence: 0.82,
  evidence: ['src/cache/lru.ts:142'],
  claim: 'The eviction path races with concurrent reads under load.',
};

const VALID_SIGNAL_BLOCK = { signal: VALID_SIGNAL };

function fenced(body: unknown): string {
  return '```json\n' + JSON.stringify(body, null, 2) + '\n```';
}

function makeMessage(content: string): Message {
  return {
    role: 'assistant',
    content,
    timestamp: new Date(),
    metadata: { usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildResultFromMessage — signal wiring', () => {
  describe('no outputSchema', () => {
    it('attaches signal when the message contains a valid SIGNAL block', () => {
      const content = 'Analysis complete.\n\n' + fenced(VALID_SIGNAL_BLOCK);
      const result = buildResultFromMessage('a', 'succeeded', makeMessage(content), undefined);
      expect(result.signal).toEqual(VALID_SIGNAL);
    });

    it('leaves signal absent when the message has no SIGNAL block', () => {
      const content = 'No structured signal here.';
      const result = buildResultFromMessage('b', 'succeeded', makeMessage(content), undefined);
      expect(result.signal).toBeUndefined();
    });

    it('leaves signal absent when the SIGNAL block is malformed (bad stance enum)', () => {
      const malformed = {
        signal: {
          issue: 'i',
          stance: 'maybe', // invalid — not in enum
          confidence: 0.5,
          evidence: [],
          claim: 'c',
        },
      };
      const content = fenced(malformed);
      const result = buildResultFromMessage('c', 'succeeded', makeMessage(content), undefined);
      expect(result.signal).toBeUndefined();
    });

    it('leaves signal absent when the SIGNAL block has missing required fields', () => {
      const malformed = { signal: { issue: 'x' } };
      const content = fenced(malformed);
      const result = buildResultFromMessage('d', 'succeeded', makeMessage(content), undefined);
      expect(result.signal).toBeUndefined();
    });
  });

  describe('with outputSchema — signal is independent of schema outcome', () => {
    const OutputSchema = z.object({ value: z.string() });
    const VALID_OUTPUT = { value: 'hello' };

    it('populates both output and signal when schema matches and SIGNAL block is present', () => {
      // Single cohabitated block carrying both schema keys and signal key.
      const combined = { ...VALID_OUTPUT, ...VALID_SIGNAL_BLOCK };
      const content = 'result:\n\n' + fenced(combined);
      const result = buildResultFromMessage('e', 'succeeded', makeMessage(content), OutputSchema);
      expect(result.status).toBe('succeeded');
      expect(result.output).toEqual(VALID_OUTPUT);
      expect(result.signal).toEqual(VALID_SIGNAL);
    });

    it('carries signal on schema-mismatch failure (status failed, schemaError set, signal present)', () => {
      // Schema expects { value: string } but message has wrong shape.
      // Signal block is a separate fenced block before the schema block.
      const content = [
        fenced(VALID_SIGNAL_BLOCK),
        'output:',
        fenced({ wrong_key: 42 }),
      ].join('\n');
      const result = buildResultFromMessage('f', 'succeeded', makeMessage(content), OutputSchema);
      expect(result.status).toBe('failed');
      expect(result.schemaError).toBeDefined();
      expect(result.signal).toEqual(VALID_SIGNAL);
    });

    it('leaves signal absent on schema failure when no SIGNAL block is present', () => {
      const content = fenced({ wrong_key: 42 });
      const result = buildResultFromMessage('g', 'succeeded', makeMessage(content), OutputSchema);
      expect(result.status).toBe('failed');
      expect(result.signal).toBeUndefined();
    });
  });
});

describe('buildResultFromMessage — stopReason wiring', () => {
  it('attaches stopReason when provided (no outputSchema)', () => {
    const result = buildResultFromMessage(
      'h',
      'succeeded',
      makeMessage('capped partial'),
      undefined,
      undefined,
      'tool_use_loop_capped',
    );
    expect(result.stopReason).toBe('tool_use_loop_capped');
  });

  it('leaves stopReason absent when not provided', () => {
    const result = buildResultFromMessage('i', 'succeeded', makeMessage('done'), undefined);
    expect(result.stopReason).toBeUndefined();
    expect('stopReason' in result).toBe(false);
  });

  it('carries stopReason through the schema-failure path', () => {
    const OutputSchema = z.object({ answer: z.string() });
    const result = buildResultFromMessage(
      'j',
      'succeeded',
      makeMessage(fenced({ wrong_key: 42 })),
      OutputSchema,
      undefined,
      'end_turn',
    );
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('end_turn');
  });
});

describe('isIncompleteStopReason — partial-result classification', () => {
  it('is true for the tool-use loop cap', () => {
    expect(isIncompleteStopReason(TOOL_USE_LOOP_CAPPED)).toBe(true);
  });

  it('is true for a stream-truncated run', () => {
    expect(isIncompleteStopReason(STREAM_INCOMPLETE)).toBe(true);
  });

  it('is false for a clean terminal stop reason', () => {
    expect(isIncompleteStopReason('end_turn')).toBe(false);
  });

  it('is false when the stop reason is absent', () => {
    expect(isIncompleteStopReason(undefined)).toBe(false);
  });

  it('is false for an unrelated provider stop reason', () => {
    expect(isIncompleteStopReason('max_tokens')).toBe(false);
  });
});

describe('annotateIfIncomplete — parent-visible partial marker', () => {
  const BODY = 'here are my intermediate findings';

  it('returns content unchanged for a clean completion', () => {
    expect(annotateIfIncomplete(BODY, 'end_turn')).toBe(BODY);
  });

  it('returns content unchanged when the stop reason is absent', () => {
    expect(annotateIfIncomplete(BODY, undefined)).toBe(BODY);
  });

  it('prepends a PARTIAL marker naming the iteration cap and preserves the body', () => {
    const out = annotateIfIncomplete(BODY, TOOL_USE_LOOP_CAPPED);
    expect(out).not.toBe(BODY);
    expect(out).toContain('PARTIAL RESULT');
    expect(out).toContain('tool-use iteration cap');
    expect(out).toContain(BODY);
    // The original body must survive verbatim as a suffix so downstream
    // renderers/parsers still see the full text after the marker.
    expect(out.endsWith(BODY)).toBe(true);
  });

  it('prepends a PARTIAL marker describing a cut-off stream and preserves the body', () => {
    const out = annotateIfIncomplete(BODY, STREAM_INCOMPLETE);
    expect(out).not.toBe(BODY);
    expect(out).toContain('PARTIAL RESULT');
    expect(out).toContain('cut off');
    expect(out.endsWith(BODY)).toBe(true);
  });
});

describe('incompleteToolResultFields — structured ToolResult counterpart', () => {
  it('returns {incomplete:true, incompleteReason} for the tool-use loop cap', () => {
    expect(incompleteToolResultFields(TOOL_USE_LOOP_CAPPED)).toEqual({
      incomplete: true,
      incompleteReason: TOOL_USE_LOOP_CAPPED,
    });
  });

  it('returns {incomplete:true, incompleteReason} for a stream-truncated run', () => {
    expect(incompleteToolResultFields(STREAM_INCOMPLETE)).toEqual({
      incomplete: true,
      incompleteReason: STREAM_INCOMPLETE,
    });
  });

  it('returns {} for a clean terminal stop reason', () => {
    expect(incompleteToolResultFields('end_turn')).toEqual({});
  });

  it('returns {} when the stop reason is undefined', () => {
    expect(incompleteToolResultFields(undefined)).toEqual({});
  });
});

// Invariant: an exhausted mid-stream 529 (#762) ends the child's turn CLEANLY,
// so `handle.ts`'s `if (finalMessage) return finalMessage` short-circuits every
// salvage guard and the run resolves `succeeded` carrying only the
// operator-facing overload notice. Unless OVERLOAD_EXHAUSTED is classified
// incomplete here, mint's phase guards accept that notice as a real
// spec/plan/research artifact (#764 review).
describe('OVERLOAD_EXHAUSTED — overload-killed fork is not a clean answer', () => {
  it('classifies an exhausted overload as incomplete', () => {
    expect(isIncompleteStopReason(OVERLOAD_EXHAUSTED)).toBe(true);
  });

  it('names the overload cause in the parent-visible banner', () => {
    const out = annotateIfIncomplete('partial findings', OVERLOAD_EXHAUSTED);
    expect(out).toContain('529');
    expect(out).toContain('PARTIAL RESULT');
    expect(out).toContain('partial findings');
  });

  it('sets the structured ToolResult fields', () => {
    expect(incompleteToolResultFields(OVERLOAD_EXHAUSTED)).toEqual({
      incomplete: true,
      incompleteReason: OVERLOAD_EXHAUSTED,
    });
  });
});

// Invariant: SOFT_DEADLINE_WIND_DOWN and TOOL_USE_LOOP_CAPPED are the SAME
// mechanism (one tools-stripped synthesis round) fired by different budgets —
// wall-clock nearly spent vs. rounds spent — so they must never be classified
// differently here. A wind-down answer is by construction "what I established,
// what remains unresolved", so omitting this arm hands the parent model an
// explicitly-unfinished report as a conclusion, and mint's phase guards accept
// it as a real spec/plan/research artifact. Regression guard for the #938
// review: the first implementation wired the new stop reason through both
// providers but missed this classifier, which is the consumption boundary where
// the distinction actually reaches a parent.
describe('SOFT_DEADLINE_WIND_DOWN — a wall-clock wind-down is not a clean answer', () => {
  it('classifies a soft-deadline wind-down as incomplete', () => {
    expect(isIncompleteStopReason(SOFT_DEADLINE_WIND_DOWN)).toBe(true);
  });

  it('classifies it identically to the round-budget sibling', () => {
    expect(isIncompleteStopReason(SOFT_DEADLINE_WIND_DOWN)).toBe(
      isIncompleteStopReason(TOOL_USE_LOOP_CAPPED),
    );
  });

  it('names the wall-clock cause in the parent-visible banner, not the tool cap', () => {
    const out = annotateIfIncomplete('partial findings', SOFT_DEADLINE_WIND_DOWN);
    expect(out).toContain('PARTIAL RESULT');
    expect(out).toContain('wall-clock');
    expect(out).toContain('partial findings');
    expect(out).not.toContain('tool-use iteration cap');
  });

  it('sets the structured ToolResult fields', () => {
    expect(incompleteToolResultFields(SOFT_DEADLINE_WIND_DOWN)).toEqual({
      incomplete: true,
      incompleteReason: SOFT_DEADLINE_WIND_DOWN,
    });
  });
});
