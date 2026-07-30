// Outcome triage for a forked skill (`SubagentResult` → `ToolResult`).
//
// The load-bearing case is the FAILED-with-partial-output branch: an own-budget
// wall-clock timeout and an idle-watchdog abort both resolve `status: 'failed'`
// (NOT 'cancelled'), so before this branch existed a fork killed by its own
// budget returned a bare "Operation timed out after Nms" and silently discarded
// every finding it had already streamed. That discard is what made bounding a
// skill fork's runtime unsafe.

import { describe, it, expect } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources';
import {
  renderForkOutcome,
  failedPartialMarker,
  CANCELLED_PARTIAL_MARKER,
} from './fork-result.js';
import { STREAM_INCOMPLETE, type SubagentResult } from '../../subagent/result.js';

const NO_OUTPUT = 'Forked skill failed with no output';

function makeResult(over: Partial<SubagentResult>): SubagentResult {
  return { id: 'sub_1', status: 'failed', ...over } as SubagentResult;
}

/** Minimal succeeded message carrying `content` (the only field read here). */
function messageWith(content: string): Message {
  return { content } as unknown as Message;
}

describe('renderForkOutcome — succeeded', () => {
  it('returns the child content verbatim on a clean completion', () => {
    const out = renderForkOutcome(
      makeResult({ status: 'succeeded', message: messageWith('grounding brief') }),
      NO_OUTPUT,
    );
    expect(out.content).toBe('grounding brief');
    expect(out.isError).toBeUndefined();
    expect(out.incomplete).toBeUndefined();
  });

  it('annotates + flags a succeeded-but-incomplete partial', () => {
    const out = renderForkOutcome(
      makeResult({
        status: 'succeeded',
        message: messageWith('half a brief'),
        stopReason: STREAM_INCOMPLETE,
      }),
      NO_OUTPUT,
    );
    expect(out.content).toContain('half a brief');
    expect(out.content).not.toBe('half a brief'); // banner prepended
    expect(out.incomplete).toBe(true);
    expect(out.incompleteReason).toBe(STREAM_INCOMPLETE);
  });
});

describe('renderForkOutcome — cancelled', () => {
  it('preserves partial output behind the cancelled marker, not as an error', () => {
    const out = renderForkOutcome(
      makeResult({ status: 'cancelled', partialOutput: 'found 3 dirty files' }),
      NO_OUTPUT,
    );
    expect(out.content).toBe(`${CANCELLED_PARTIAL_MARKER}\n\nfound 3 dirty files`);
    // A user interrupt is not a skill error — isError must stay unset.
    expect(out.isError).toBeUndefined();
  });

  it('falls through to the error path when cancellation produced nothing', () => {
    const out = renderForkOutcome(
      makeResult({ status: 'cancelled', error: new Error('aborted by user') }),
      NO_OUTPUT,
    );
    expect(out.content).toBe('aborted by user');
    expect(out.isError).toBe(true);
  });
});

describe('renderForkOutcome — failed (the R2a fix)', () => {
  it('preserves partial output on an own-budget timeout instead of discarding it', () => {
    const timeout = new Error('Operation timed out after 480000ms (skill-fork-ground-state)');
    const out = renderForkOutcome(
      makeResult({
        status: 'failed',
        error: timeout,
        partialOutput: 'branch: main @ b673c60, 3 dirty files, upstream in sync',
      }),
      NO_OUTPUT,
    );
    // The findings survive...
    expect(out.content).toContain('branch: main @ b673c60, 3 dirty files, upstream in sync');
    // ...behind a marker that names the failure, so they cannot read as complete...
    expect(out.content.startsWith(failedPartialMarker(timeout.message))).toBe(true);
    expect(out.content).toContain('Operation timed out after 480000ms');
    // ...and the call is still unambiguously a failure.
    expect(out.isError).toBe(true);
  });

  it('preserves partial output on an idle-watchdog abort (same failed status)', () => {
    const out = renderForkOutcome(
      makeResult({
        status: 'failed',
        error: new Error('Subagent idle for 480000ms with no output'),
        partialOutput: 'partial findings',
      }),
      NO_OUTPUT,
    );
    expect(out.content).toContain('partial findings');
    expect(out.isError).toBe(true);
  });

  it('still returns a bare error when the fork produced no text', () => {
    const out = renderForkOutcome(
      makeResult({ status: 'failed', error: new Error('boom') }),
      NO_OUTPUT,
    );
    expect(out.content).toBe('boom');
    expect(out.isError).toBe(true);
  });

  it('falls back to the caller-supplied no-output message when error is absent', () => {
    const out = renderForkOutcome(makeResult({ status: 'failed' }), NO_OUTPUT);
    expect(out.content).toBe(NO_OUTPUT);
    expect(out.isError).toBe(true);
  });

  it('ignores an empty-string partial rather than emitting a bare marker', () => {
    const out = renderForkOutcome(
      makeResult({ status: 'failed', error: new Error('boom'), partialOutput: '' }),
      NO_OUTPUT,
    );
    expect(out.content).toBe('boom');
  });

  it('ignores a non-string partial (schema-typed success-path value)', () => {
    const out = renderForkOutcome(
      makeResult({ status: 'failed', error: new Error('boom'), partialOutput: { a: 1 } }),
      NO_OUTPUT,
    );
    expect(out.content).toBe('boom');
  });

  it('carries the structured incomplete fields through the failed-partial branch', () => {
    const out = renderForkOutcome(
      makeResult({
        status: 'failed',
        error: new Error('stream ended early'),
        partialOutput: 'some text',
        stopReason: STREAM_INCOMPLETE,
      }),
      NO_OUTPUT,
    );
    expect(out.incomplete).toBe(true);
    expect(out.incompleteReason).toBe(STREAM_INCOMPLETE);
    expect(out.isError).toBe(true);
  });
});
