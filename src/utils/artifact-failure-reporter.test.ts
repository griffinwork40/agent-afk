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

  // Object dedup keys are latched by IDENTITY (WeakMap), not by structural
  // equality or by calling anything on them. Two distinct object keys must
  // each get their own first-failure warning; the same object reused twice
  // must warn only once — exactly like the string-keyed behavior above.
  it('latches object dedup keys by identity: distinct objects each warn once, the same object warns only once', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sinkA = {};
      const sinkB = {};

      reportArtifactFailure('trace.emit', sinkA, 'tool_call', new Error('EACCES'));
      reportArtifactFailure('trace.emit', sinkB, 'tool_call', new Error('EACCES'));
      // Same instance as sinkA again — must NOT produce a third warning.
      reportArtifactFailure('trace.emit', sinkA, 'abort', new Error('EACCES'));

      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Never-throw on a hostile key: the reporter must identify an object
  // dedup key ONLY by identity, never by touching its members. A key whose
  // `getTracePath` throws on access (getter) or on call proves the reporter
  // never reads or invokes anything on the object it was handed.
  it('never touches members of an object dedup key, even a hostile one that throws on access', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hostileKey = {
        get getTracePath(): never {
          throw new Error('accessing getTracePath must never happen');
        },
      };

      expect(() =>
        reportArtifactFailure('x', hostileKey, 'y', new Error('e')),
      ).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // A second failure on the SAME hostile key must fall back to debugLog,
      // not warn again — proving the identity latch recognized it.
      reportArtifactFailure('x', hostileKey, 'y', new Error('e2'));
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // The string-keyed latch is bounded (FIFO eviction), not an unbounded
  // leak. Report enough distinct string keys to overflow the cap, then
  // re-report the very first key: it must warn visibly again, proving its
  // entry was evicted rather than retained forever. Asserted purely through
  // observable re-warning — no reach into internal Map size.
  it('bounds the string-keyed latch: overflowing it evicts the oldest entry, which then warns again', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const firstKey = 'session-0000';
      reportArtifactFailure('bounded-latch', firstKey, 'write', new Error('e'));
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // Push 300 more distinct keys through the same subsystem — well past
      // the internal cap — none of which is firstKey.
      for (let i = 1; i <= 300; i++) {
        reportArtifactFailure('bounded-latch', `session-${i}`, 'write', new Error('e'));
      }
      const callsAfterFill = errorSpy.mock.calls.length;
      // Every one of the 300 fresh keys is a first sighting, so each warns.
      expect(callsAfterFill).toBe(301);

      // firstKey's entry should have been evicted by now — re-reporting it
      // must be treated as a first sighting again (a NEW visible warning),
      // not swallowed into debugLog as a repeat.
      reportArtifactFailure('bounded-latch', firstKey, 'write', new Error('e-again'));
      expect(errorSpy).toHaveBeenCalledTimes(callsAfterFill + 1);

      // Behavior remains stable after eviction — reporting a genuinely new
      // key still warns, proving the latch didn't wedge or grow unbounded.
      reportArtifactFailure('bounded-latch', 'session-brand-new', 'write', new Error('e3'));
      expect(errorSpy).toHaveBeenCalledTimes(callsAfterFill + 2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
