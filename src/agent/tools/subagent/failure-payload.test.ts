/**
 * Direct unit tests for the failure-path payload + telemetry helpers.
 *
 * Follow-up to #443: these helpers were extracted from `subagent-executor.ts`
 * and previously covered only transitively through `subagent-executor.test.ts`.
 * `truncate`, `measurePartial`, and `buildFailurePayload` are pure — tested
 * here directly at boundaries. `emitTelemetry` wraps `appendRoutingDecision`;
 * it is tested with a hoisted module mock (matching the harness in
 * `subagent-executor.test.ts`) to assert the best-effort no-throw contract.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Hoisted mock so failure-payload.ts picks up the mocked appendRoutingDecision.
// Mirrors the pattern used in subagent-executor.test.ts.
const appendRoutingDecision = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision }));

import {
  emitTelemetry,
  truncate,
  measurePartial,
  buildFailurePayload,
  type StructuredFailurePayload,
} from './failure-payload.js';

describe('truncate', () => {
  it('returns the string unchanged when at or below the limit', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('returns the string unchanged at the exact boundary (length === max)', () => {
    const s = 'x'.repeat(10);
    expect(truncate(s, 10)).toBe(s);
  });

  it('truncates and appends an ellipsis when one char over the limit', () => {
    const s = 'x'.repeat(11);
    const result = truncate(s, 10);
    expect(result).toBe('x'.repeat(10) + '…');
    // Result is max + 1 (the single ellipsis char).
    expect(result.length).toBe(11);
  });

  it('truncates long strings to max chars + ellipsis', () => {
    const result = truncate('y'.repeat(1000), 240);
    expect(result.length).toBe(241);
    expect(result.endsWith('…')).toBe(true);
  });

  it('uses the default max of 240 when none is supplied', () => {
    const result = truncate('z'.repeat(500));
    expect(result.length).toBe(241);
    expect(result).toBe('z'.repeat(240) + '…');
  });

  it('leaves a string shorter than the default max untouched', () => {
    expect(truncate('a few words')).toBe('a few words');
  });

  it('handles the empty string', () => {
    expect(truncate('', 240)).toBe('');
  });
});

describe('measurePartial', () => {
  it('returns undefined for undefined', () => {
    expect(measurePartial(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(measurePartial(null)).toBeUndefined();
  });

  it('returns the string length for a string (not the JSON-encoded length)', () => {
    // A raw string is measured by .length, not JSON.stringify (which would add
    // surrounding quotes → length + 2).
    expect(measurePartial('hello')).toBe(5);
  });

  it('returns 0 for the empty string', () => {
    // Empty string is not null/undefined, so it takes the string branch → 0.
    expect(measurePartial('')).toBe(0);
  });

  it('returns the serialized length for an object', () => {
    const obj = { a: 1, b: 'two' };
    expect(measurePartial(obj)).toBe(JSON.stringify(obj).length);
  });

  it('returns the serialized length for an array', () => {
    const arr = [1, 2, 3];
    expect(measurePartial(arr)).toBe(JSON.stringify(arr).length);
  });

  it('returns the serialized length for a number', () => {
    // JSON.stringify(42) === '42' → length 2.
    expect(measurePartial(42)).toBe(2);
  });

  it('returns undefined when the value is not serializable (circular ref)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(measurePartial(circular)).toBeUndefined();
  });

  it('returns undefined when the value contains a BigInt (JSON.stringify throws)', () => {
    expect(measurePartial({ big: 1n })).toBeUndefined();
  });
});

describe('buildFailurePayload', () => {
  it('builds the minimal payload with status, error, and subagent_id', () => {
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'something exploded',
      subagentId: 'child-1',
    });
    const expected: StructuredFailurePayload = {
      status: 'failed',
      error: 'something exploded',
      subagent_id: 'child-1',
    };
    expect(payload).toEqual(expected);
  });

  it('omits schemaError when not supplied', () => {
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      subagentId: 'c',
    });
    expect('schemaError' in payload).toBe(false);
  });

  it('omits schemaError when supplied as an empty string (falsy)', () => {
    // The `if (args.schemaErrorMessage)` guard treats '' as absent.
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      schemaErrorMessage: '',
      subagentId: 'c',
    });
    expect('schemaError' in payload).toBe(false);
  });

  it('includes schemaError when supplied', () => {
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      schemaErrorMessage: 'expected string, got number',
      subagentId: 'c',
    });
    expect(payload.schemaError).toBe('expected string, got number');
  });

  it('omits partialOutput when not supplied', () => {
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      subagentId: 'c',
    });
    expect('partialOutput' in payload).toBe(false);
  });

  it('omits partialOutput when supplied as null', () => {
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      partialOutput: null,
      subagentId: 'c',
    });
    expect('partialOutput' in payload).toBe(false);
  });

  it('passes through a small partialOutput unchanged', () => {
    const partial = { steps: ['a', 'b'], note: 'halfway' };
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      partialOutput: partial,
      subagentId: 'c',
    });
    expect(payload.partialOutput).toEqual(partial);
  });

  it('passes through a small string partialOutput unchanged', () => {
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      partialOutput: 'small partial',
      subagentId: 'c',
    });
    expect(payload.partialOutput).toBe('small partial');
  });

  it('replaces an over-large partialOutput with a {truncated, chars} marker', () => {
    // ~10KB serialized — well past the 4096-char cap.
    const big = { blob: 'x'.repeat(10_000) };
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      partialOutput: big,
      subagentId: 'c',
    });
    expect(payload.partialOutput).toEqual({
      truncated: true,
      chars: JSON.stringify(big).length,
    });
    // The raw blob must not be inlined into the payload.
    expect(JSON.stringify(payload)).not.toContain('xxxxxxxxxx');
  });

  it('keeps a partialOutput that is exactly at the 4096-char cap (boundary)', () => {
    // A raw string is measured by measurePartial via `.length` (NOT the
    // JSON-encoded length), so a 4096-char string measures as exactly 4096.
    // `chars > 4096` is false at the boundary → passthrough.
    const atCap = 'x'.repeat(4096);
    expect(measurePartial(atCap)).toBe(4096);
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      partialOutput: atCap,
      subagentId: 'c',
    });
    expect(payload.partialOutput).toBe(atCap);
  });

  it('replaces a string partialOutput that is one char over the cap', () => {
    // 4097 chars measures as 4097 > 4096 → truncated marker.
    const overCap = 'x'.repeat(4097);
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      partialOutput: overCap,
      subagentId: 'c',
    });
    expect(payload.partialOutput).toEqual({ truncated: true, chars: 4097 });
  });

  it('truncates the error message to the 1024-char cap (+ ellipsis)', () => {
    const huge = 'E'.repeat(5000);
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: huge,
      subagentId: 'c',
    });
    // 1024 chars + 1 ellipsis.
    expect(payload.error.length).toBe(1025);
    expect(payload.error.endsWith('…')).toBe(true);
  });

  it('truncates the schemaError message to the 1024-char cap (+ ellipsis)', () => {
    const huge = 'S'.repeat(5000);
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'e',
      schemaErrorMessage: huge,
      subagentId: 'c',
    });
    expect(payload.schemaError).toBeDefined();
    expect(payload.schemaError!.length).toBe(1025);
  });

  it('produces a payload that excludes prompts/stack-traces/credentials by construction', () => {
    // Documented invariant: the payload carries ONLY status, error,
    // schemaError, partialOutput, subagent_id. Even if a caller passes a
    // long error string, no extra keys leak. This pins the shape so a future
    // edit that widens the payload has to update this test.
    const payload = buildFailurePayload({
      status: 'failed',
      errorMessage: 'boom',
      schemaErrorMessage: 'schema mismatch',
      partialOutput: { some: 'state' },
      subagentId: 'child-x',
    });
    expect(Object.keys(payload).sort()).toEqual(
      ['error', 'partialOutput', 'schemaError', 'status', 'subagent_id'].sort(),
    );
  });
});

describe('emitTelemetry', () => {
  beforeEach(() => {
    appendRoutingDecision.mockClear();
    appendRoutingDecision.mockResolvedValue(undefined);
  });

  it('forwards the entry to appendRoutingDecision', async () => {
    const entry = {
      event: 'subagent.completed' as const,
      subagent_id: 'sub-1',
    };
    await emitTelemetry(entry as Parameters<typeof emitTelemetry>[0]);
    expect(appendRoutingDecision).toHaveBeenCalledTimes(1);
    expect(appendRoutingDecision).toHaveBeenCalledWith(entry);
  });

  it('swallows a rejected appendRoutingDecision (best-effort, never rejects)', async () => {
    appendRoutingDecision.mockRejectedValueOnce(new Error('telemetry sink down'));
    // The wrapper .catch(() => {})s the rejection, so the returned promise
    // resolves rather than rejecting.
    await expect(
      emitTelemetry({} as Parameters<typeof emitTelemetry>[0]),
    ).resolves.toBeUndefined();
  });

  it('swallows a synchronous throw from appendRoutingDecision', async () => {
    // Defense in depth: even if the helper throws synchronously (it should not),
    // emitTelemetry returns a resolved promise rather than propagating.
    appendRoutingDecision.mockImplementationOnce(() => {
      throw new Error('sync explosion');
    });
    await expect(
      emitTelemetry({} as Parameters<typeof emitTelemetry>[0]),
    ).resolves.toBeUndefined();
  });
});
