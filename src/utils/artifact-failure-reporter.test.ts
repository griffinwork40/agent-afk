/**
 * Unit tests for the shared artifact-failure reporter (#850).
 *
 * Covers the reporter's own contract in isolation:
 *  - AC1: the first failure for a (subsystem, dedupKey) pair surfaces to
 *    stderr (`console.error`) unconditionally — no `AFK_DEBUG=1` required.
 *  - AC3: a second failure for the SAME pair does not re-surface to stderr —
 *    it falls back to `debugLog`, so a wedged subsystem warns once, not
 *    once per call.
 *
 * The never-throw contract (AC2) is exercised end-to-end through a real
 * call site in `agent/trace/emit.test.ts`, since that is where the
 * production caller (`emitToolCall`) actually lives.
 *
 * @module utils/artifact-failure-reporter.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./debug.js', () => ({ debugLog: vi.fn() }));

import { debugLog } from './debug.js';
import {
  reportArtifactFailure,
  resetArtifactFailureReporterForTests,
} from './artifact-failure-reporter.js';

describe('reportArtifactFailure', () => {
  beforeEach(() => {
    resetArtifactFailureReporterForTests();
    vi.mocked(debugLog).mockClear();
  });

  afterEach(() => {
    resetArtifactFailureReporterForTests();
  });

  // AC1: enabling an observability feature that then fails must produce at
  // least one operator-visible signal WITHOUT AFK_DEBUG=1.
  it('surfaces the first failure to console.error unconditionally, without AFK_DEBUG', () => {
    const originalDebug = process.env['AFK_DEBUG'];
    delete process.env['AFK_DEBUG'];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportArtifactFailure('trace.emit', '/tmp/session-a/trace.jsonl', 'tool_call', new Error('EACCES'));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = errorSpy.mock.calls[0]?.[0];
      expect(typeof message).toBe('string');
      expect(message).toContain('trace.emit');
      expect(message).toContain('tool_call');
      expect(message).toContain('EACCES');
      // The first failure must not also fall back to debugLog — exactly one
      // visible channel per failure.
      expect(debugLog).not.toHaveBeenCalled();
    } finally {
      if (originalDebug !== undefined) process.env['AFK_DEBUG'] = originalDebug;
      errorSpy.mockRestore();
    }
  });

  // AC3: a forced write failure emits the signal EXACTLY ONCE — not zero
  // times, not once per call. A wedged subsystem (every call to the same
  // sink failing) must not flood the operator's terminal.
  it('surfaces only the FIRST failure per (subsystem, dedupKey); later failures fall back to debugLog', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportArtifactFailure('trace.emit', '/tmp/session-a/trace.jsonl', 'tool_call', new Error('disk full'));
      reportArtifactFailure('trace.emit', '/tmp/session-a/trace.jsonl', 'abort', new Error('disk full'));
      reportArtifactFailure('trace.emit', '/tmp/session-a/trace.jsonl', 'closure', new Error('disk full'));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(debugLog).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keys the once-latch on (subsystem, dedupKey) — a different subsystem or session still gets its own first warning', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportArtifactFailure('trace.emit', '/tmp/session-a/trace.jsonl', 'tool_call', new Error('EROFS'));
      // Different dedup key (different session's trace path) — still visible.
      reportArtifactFailure('trace.emit', '/tmp/session-b/trace.jsonl', 'tool_call', new Error('EROFS'));
      // Different subsystem, same key — still visible (independent latch).
      reportArtifactFailure('subagent-output-capture', '/tmp/session-a/trace.jsonl', 'write', new Error('EROFS'));

      expect(errorSpy).toHaveBeenCalledTimes(3);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('never throws even if console.error itself throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr closed');
    });
    try {
      expect(() =>
        reportArtifactFailure('trace.emit', '/tmp/session-c/trace.jsonl', 'tool_call', new Error('boom')),
      ).not.toThrow();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
