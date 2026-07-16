import { describe, it, expect } from 'vitest';
import {
  buildToolCallStartedPayload,
  buildToolCallCompletedPayload,
} from './tool-call-trace.js';
import type { ToolResult } from '../anthropic-direct/types.js';

describe('buildToolCallStartedPayload', () => {
  it('builds the base payload shape with subagentId omitted when undefined', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_1',
      name: 'bash',
      input: { command: 'ls' },
    });
    expect(payload.phase).toBe('started');
    expect(payload.toolUseId).toBe('tu_1');
    expect(payload.name).toBe('bash');
    // Key must be ABSENT (not present-with-undefined) so JSONL lines stay
    // clean and readers render no orphan `[subagentId]` on root calls.
    expect('subagentId' in payload).toBe(false);
  });

  it('includes subagentId when provided', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_2',
      name: 'search',
      input: { q: 'hello' },
      subagentId: 'research-agent-1700000000000-3',
    });
    expect('subagentId' in payload).toBe(true);
    expect(payload.subagentId).toBe('research-agent-1700000000000-3');
  });

  it('computes inputBytes as Buffer.byteLength(JSON.stringify(input), utf8) for a sample input', () => {
    const input = { q: 'hello', nested: { a: 1, b: [1, 2, 3] } };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_3',
      name: 'search',
      input,
    });
    expect(payload.inputBytes).toBe(Buffer.byteLength(JSON.stringify(input), 'utf8'));
    expect(payload.inputBytes).toBeGreaterThan(0);
  });

  it('computes inputBytes for undefined input as Buffer.byteLength(JSON.stringify({}))', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_4',
      name: 'noop',
      input: undefined,
    });
    expect(payload.inputBytes).toBe(Buffer.byteLength(JSON.stringify({}), 'utf8'));
  });

  it('computes inputBytes for an empty object input', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_5',
      name: 'noop',
      input: {},
    });
    expect(payload.inputBytes).toBe(Buffer.byteLength(JSON.stringify({}), 'utf8'));
  });
});

describe('buildToolCallCompletedPayload', () => {
  const baseResult: ToolResult = { content: 'ok', isError: false };

  it('builds the base payload shape', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_1',
      name: 'bash',
      result: baseResult,
      truncated: false,
      durationMs: 42,
    });
    expect(payload.phase).toBe('completed');
    expect(payload.toolUseId).toBe('tu_1');
    expect(payload.name).toBe('bash');
    expect(payload.resultBytes).toBe(Buffer.byteLength('ok', 'utf8'));
    expect(payload.isError).toBe(false);
    expect(payload.truncated).toBe(false);
    expect(payload.durationMs).toBe(42);
  });

  it('sets isError true when result.isError is true', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_err',
      name: 'bash',
      result: { content: 'boom', isError: true },
      truncated: false,
      durationMs: 5,
    });
    expect(payload.isError).toBe(true);
  });

  it('sets isError false when result.isError is false or absent', () => {
    const payload1 = buildToolCallCompletedPayload({
      toolUseId: 'tu_a',
      name: 'bash',
      result: { content: 'ok', isError: false },
      truncated: false,
      durationMs: 1,
    });
    const payload2 = buildToolCallCompletedPayload({
      toolUseId: 'tu_b',
      name: 'bash',
      result: { content: 'ok' },
      truncated: false,
      durationMs: 1,
    });
    expect(payload1.isError).toBe(false);
    expect(payload2.isError).toBe(false);
  });

  it('passes truncated and durationMs through unchanged (does not recompute them)', () => {
    const payload = buildToolCallCompletedPayload({
      toolUseId: 'tu_t',
      name: 'bash',
      // Content has no truncation sentinel and no structured flag — proves
      // the builder trusts the passed-in `truncated` rather than deriving it.
      result: { content: 'clean output, nothing truncated here' },
      truncated: true,
      durationMs: 987,
    });
    expect(payload.truncated).toBe(true);
    expect(payload.durationMs).toBe(987);
  });

  it('spreads circuitBreaker only when result.circuitBreaker === true', () => {
    const withBreaker = buildToolCallCompletedPayload({
      toolUseId: 'tu_cb',
      name: 'bash',
      result: { content: 'x', circuitBreaker: true },
      truncated: false,
      durationMs: 1,
    });
    expect(withBreaker.circuitBreaker).toBe(true);

    const withoutBreaker = buildToolCallCompletedPayload({
      toolUseId: 'tu_no_cb',
      name: 'bash',
      result: { content: 'x' },
      truncated: false,
      durationMs: 1,
    });
    expect('circuitBreaker' in withoutBreaker).toBe(false);

    const falseBreaker = buildToolCallCompletedPayload({
      toolUseId: 'tu_false_cb',
      name: 'bash',
      result: { content: 'x', circuitBreaker: false },
      truncated: false,
      durationMs: 1,
    });
    expect('circuitBreaker' in falseBreaker).toBe(false);
  });

  it('spreads failureClass only when set', () => {
    const withClass = buildToolCallCompletedPayload({
      toolUseId: 'tu_fc',
      name: 'bash',
      result: { content: 'x', isError: true, failureClass: 'timeout' },
      truncated: false,
      durationMs: 1,
    });
    expect(withClass.failureClass).toBe('timeout');

    const withoutClass = buildToolCallCompletedPayload({
      toolUseId: 'tu_no_fc',
      name: 'bash',
      result: { content: 'x', isError: true },
      truncated: false,
      durationMs: 1,
    });
    expect('failureClass' in withoutClass).toBe(false);
  });

  it('spreads batchIndex/batchSize only when BOTH are numbers', () => {
    const both = buildToolCallCompletedPayload({
      toolUseId: 'tu_batch',
      name: 'bash',
      result: { content: 'x', batchIndex: 1, batchSize: 3 },
      truncated: false,
      durationMs: 1,
    });
    expect(both.batchIndex).toBe(1);
    expect(both.batchSize).toBe(3);

    const onlyIndex = buildToolCallCompletedPayload({
      toolUseId: 'tu_only_idx',
      name: 'bash',
      result: { content: 'x', batchIndex: 1 },
      truncated: false,
      durationMs: 1,
    });
    expect('batchIndex' in onlyIndex).toBe(false);
    expect('batchSize' in onlyIndex).toBe(false);

    const onlySize = buildToolCallCompletedPayload({
      toolUseId: 'tu_only_size',
      name: 'bash',
      result: { content: 'x', batchSize: 3 },
      truncated: false,
      durationMs: 1,
    });
    expect('batchIndex' in onlySize).toBe(false);
    expect('batchSize' in onlySize).toBe(false);

    const neither = buildToolCallCompletedPayload({
      toolUseId: 'tu_neither',
      name: 'bash',
      result: { content: 'x' },
      truncated: false,
      durationMs: 1,
    });
    expect('batchIndex' in neither).toBe(false);
    expect('batchSize' in neither).toBe(false);
  });

  it('includes subagentId when provided, omits it when undefined', () => {
    const withId = buildToolCallCompletedPayload({
      toolUseId: 'tu_sub',
      name: 'bash',
      result: { content: 'x' },
      truncated: false,
      durationMs: 1,
      subagentId: 'research-agent-1700000000000-3',
    });
    expect('subagentId' in withId).toBe(true);
    expect(withId.subagentId).toBe('research-agent-1700000000000-3');

    const withoutId = buildToolCallCompletedPayload({
      toolUseId: 'tu_no_sub',
      name: 'bash',
      result: { content: 'x' },
      truncated: false,
      durationMs: 1,
    });
    expect('subagentId' in withoutId).toBe(false);
  });
});
