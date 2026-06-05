/**
 * Tests for `improve/scan/reader.ts`.
 *
 * Verifies:
 *   - parseDuration handles supported units, rejects garbage.
 *   - parseTraceContent skips invalid JSONL lines but counts them.
 *   - parseTraceContent skips lines that don't match TraceEventSchema.
 *   - parseTraceContent preserves event order and line numbers.
 */

import { describe, it, expect } from 'vitest';
import { parseDuration, parseTraceContent } from './reader.js';

describe('parseDuration', () => {
  it('parses days', () => {
    expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
  });

  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });

  it('parses seconds', () => {
    expect(parseDuration('3600s')).toBe(3600 * 1000);
  });

  it('tolerates whitespace and case', () => {
    expect(parseDuration('  7D  ')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('rejects unparseable input', () => {
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('garbage')).toBeUndefined();
    expect(parseDuration('7')).toBeUndefined();
    expect(parseDuration('d7')).toBeUndefined();
    expect(parseDuration('0d')).toBeUndefined();
    expect(parseDuration('-1d')).toBeUndefined();
  });
});

describe('parseTraceContent', () => {
  const baseArgs = {
    sessionId: 'session-A',
    tracePath: '/abs/state/witness/session-A/trace.jsonl',
    relativeTracePath: 'state/witness/session-A/trace.jsonl',
    sessionMtimeMs: 1_700_000_000_000,
  };

  function event(
    seq: number,
    payload: Record<string, unknown>,
  ): string {
    const obj = {
      ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
      seq,
      kind: 'tool_call',
      payload,
    };
    return JSON.stringify(obj);
  }

  it('parses a clean trace, preserving order and line numbers', () => {
    const lines = [
      event(0, { phase: 'started', toolUseId: 'a', name: 'grep', inputBytes: 100 }),
      event(1, {
        phase: 'completed',
        toolUseId: 'a',
        name: 'grep',
        resultBytes: 200,
        isError: false,
        truncated: false,
        durationMs: 50,
      }),
    ];
    const result = parseTraceContent({ ...baseArgs, content: lines.join('\n') });

    expect(result.invalidLineCount).toBe(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.lineNumber).toBe(1);
    expect(result.events[1]?.lineNumber).toBe(2);
    expect(result.events[0]?.event.seq).toBe(0);
    expect(result.events[1]?.event.seq).toBe(1);
    expect(result.events[0]?.sessionId).toBe('session-A');
    expect(result.events[0]?.relativeTracePath).toBe('state/witness/session-A/trace.jsonl');
  });

  it('skips invalid JSON lines but counts them', () => {
    const lines = [
      event(0, { phase: 'started', toolUseId: 'a', name: 'grep', inputBytes: 100 }),
      '{ this is not valid json',
      event(1, {
        phase: 'completed',
        toolUseId: 'a',
        name: 'grep',
        resultBytes: 200,
        isError: false,
        truncated: false,
        durationMs: 50,
      }),
    ];
    const result = parseTraceContent({ ...baseArgs, content: lines.join('\n') });

    expect(result.invalidLineCount).toBe(1);
    expect(result.events).toHaveLength(2);
    // Line numbers reflect file position — invalid line was line 2.
    expect(result.events[0]?.lineNumber).toBe(1);
    expect(result.events[1]?.lineNumber).toBe(3);
  });

  it('skips schema-mismatch lines but counts them', () => {
    const lines = [
      event(0, { phase: 'started', toolUseId: 'a', name: 'grep', inputBytes: 100 }),
      // Valid JSON, missing required fields — should fail TraceEventSchema.
      JSON.stringify({ ts: '2020-01-01T00:00:00Z', seq: 1, kind: 'tool_call' }),
      event(1, {
        phase: 'completed',
        toolUseId: 'a',
        name: 'grep',
        resultBytes: 200,
        isError: false,
        truncated: false,
        durationMs: 50,
      }),
    ];
    const result = parseTraceContent({ ...baseArgs, content: lines.join('\n') });

    expect(result.invalidLineCount).toBe(1);
    expect(result.events).toHaveLength(2);
  });

  it('ignores empty trailing lines', () => {
    const lines = [
      event(0, { phase: 'started', toolUseId: 'a', name: 'grep', inputBytes: 100 }),
      '',
      '',
    ];
    const result = parseTraceContent({ ...baseArgs, content: lines.join('\n') });

    expect(result.invalidLineCount).toBe(0);
    expect(result.events).toHaveLength(1);
  });

  it('handles empty content', () => {
    const result = parseTraceContent({ ...baseArgs, content: '' });
    expect(result.events).toHaveLength(0);
    expect(result.invalidLineCount).toBe(0);
  });
});
