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
import { buildResultFromMessage } from './result.js';

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
