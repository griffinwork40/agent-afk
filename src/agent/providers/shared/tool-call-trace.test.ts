import { createHash } from 'crypto';
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

  it('computes argsFingerprint as SHA-256 hex of JSON.stringify(input)', () => {
    const input = { file_path: '/src/agent/session.ts', offset: 1, limit: 50 };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_fp1',
      name: 'read_file',
      input,
    });
    const expected = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
    expect(payload.argsFingerprint).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it('produces identical argsFingerprint for identical inputs', () => {
    const input = { file_path: '/src/foo.ts' };
    const a = buildToolCallStartedPayload({ toolUseId: 'a', name: 'read_file', input });
    const b = buildToolCallStartedPayload({ toolUseId: 'b', name: 'read_file', input });
    expect(a.argsFingerprint).toBe(b.argsFingerprint);
  });

  it('produces different argsFingerprint for different inputs', () => {
    const a = buildToolCallStartedPayload({
      toolUseId: 'a', name: 'read_file', input: { file_path: '/src/a.ts' },
    });
    const b = buildToolCallStartedPayload({
      toolUseId: 'b', name: 'read_file', input: { file_path: '/src/b.ts' },
    });
    expect(a.argsFingerprint).not.toBe(b.argsFingerprint);
  });

  it('argsFingerprint for undefined input matches empty-object hash', () => {
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_und',
      name: 'noop',
      input: undefined,
    });
    const expected = createHash('sha256').update(JSON.stringify({})).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  it('redacts browser_act fill value from argsFingerprint (security)', () => {
    const secret = 'my-super-secret-password-123';
    const input = { action: 'fill', target: { kind: 'selector', selector: '#pw' }, value: secret };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_sec',
      name: 'browser_act',
      input,
    });
    // The hash must NOT be derivable from the secret — it should match the
    // redacted version instead.
    const redacted = { ...input, value: '[REDACTED]' };
    const expectedHash = createHash('sha256').update(JSON.stringify(redacted)).digest('hex');
    expect(payload.argsFingerprint).toBe(expectedHash);

    // And must NOT match a hash of the raw input.
    const rawHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).not.toBe(rawHash);
  });

  it('does not redact browser_act non-fill actions', () => {
    const input = { action: 'click', target: { kind: 'selector', selector: '#btn' } };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_click',
      name: 'browser_act',
      input,
    });
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  it('does not redact non-browser_act tools', () => {
    const input = { command: 'echo secret', value: 'should-not-be-touched' };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_bash',
      name: 'bash',
      input,
    });
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  it('redacts config_set value when target=env (security)', () => {
    const input = { target: 'env', key: 'SOME_SECRET', value: 'sk-live-abc123', action: 'set' };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_cfg1',
      name: 'config_set',
      input,
    });
    // inputBytes uses RAW input — must include the real value length.
    expect(payload.inputBytes).toBe(Buffer.byteLength(JSON.stringify(input), 'utf8'));
    // Fingerprint must NOT match a hash of the raw input (secret is redacted).
    const rawHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).not.toBe(rawHash);
    // Stable: two calls with the same input produce the same fingerprint.
    const p2 = buildToolCallStartedPayload({ toolUseId: 'tu_cfg2', name: 'config_set', input });
    expect(payload.argsFingerprint).toBe(p2.argsFingerprint);
  });

  it('does not redact config_set with target=config (non-secret keys)', () => {
    const input = { target: 'config', key: 'temperature', value: 0.7, action: 'set' };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_cfg3',
      name: 'config_set',
      input,
    });
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
  });

  it('does not redact config_set unset action (no value field)', () => {
    const input = { target: 'env', key: 'SOME_VAR', action: 'unset' };
    const payload = buildToolCallStartedPayload({
      toolUseId: 'tu_cfg4',
      name: 'config_set',
      input,
    });
    const expected = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    expect(payload.argsFingerprint).toBe(expected);
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

  it('spreads incomplete/incompleteReason only when result carries them', () => {
    const withIncomplete = buildToolCallCompletedPayload({
      toolUseId: 'tu_inc',
      name: 'agent',
      result: { content: 'partial', incomplete: true, incompleteReason: 'tool_use_loop_capped' },
      truncated: false,
      durationMs: 1,
    });
    expect(withIncomplete.incomplete).toBe(true);
    expect(withIncomplete.incompleteReason).toBe('tool_use_loop_capped');

    // Clean ToolResult: both keys ABSENT (not present-with-falsy), matching
    // the omit-when-absent idiom used by circuitBreaker/failureClass below.
    const clean = buildToolCallCompletedPayload({
      toolUseId: 'tu_clean',
      name: 'agent',
      result: baseResult,
      truncated: false,
      durationMs: 1,
    });
    expect('incomplete' in clean).toBe(false);
    expect('incompleteReason' in clean).toBe(false);

    const falseIncomplete = buildToolCallCompletedPayload({
      toolUseId: 'tu_false_inc',
      name: 'agent',
      result: { content: 'x', incomplete: false },
      truncated: false,
      durationMs: 1,
    });
    expect('incomplete' in falseIncomplete).toBe(false);
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
