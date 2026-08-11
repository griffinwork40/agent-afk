/**
 * Tests for the #850 fix: trace `emit*` helpers must surface a swallowed
 * write failure to the operator without requiring `AFK_DEBUG=1`, while
 * preserving the never-throw fire-and-forget contract documented in this
 * module's header.
 *
 * Uses `emitSessionPhase` as the representative call site — all eleven
 * `emit*` functions share the identical `try { await writer.write(...) }
 * catch (err) { reportArtifactFailure(...) }` shape, so one forced-failure
 * exercise here validates the shared pattern without duplicating the same
 * assertion eleven times.
 *
 * @module agent/trace/emit.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetArtifactFailureReporterForTests } from '../../utils/artifact-failure-reporter.js';
import { emitSessionPhase, emitAbort, emitToolCall } from './emit.js';
import { InMemoryTraceWriter } from './writer.js';
import type { TraceWriter } from './index.js';

/**
 * A writer whose `write()` always rejects. `tracePath` is cosmetic content
 * for `getTracePath()` only — post-fix, `reportArtifactFailure`'s dedup key
 * is the writer INSTANCE itself, matched by identity, so multiple distinct
 * writers may safely share the identical `tracePath` (exercised below) and
 * still isolate correctly. Pre-fix, the dedup key was `getTracePath()`'s
 * return value, so every existing call to this helper used a unique
 * `tracePath` per test — isolation between writers passed, but only
 * because no two tests' writers ever shared a path, not because the
 * dedup logic was actually keyed on the right thing.
 */
function makeFailingWriter(tracePath: string, message: string): TraceWriter {
  const inner = new InMemoryTraceWriter();
  return {
    write: () => Promise.reject(new Error(message)),
    getTracePath: () => tracePath,
    seal: (payload) => inner.seal(payload),
    close: () => inner.close(),
  };
}

describe('emit* — #850 first-failure-visible-without-AFK_DEBUG', () => {
  beforeEach(() => {
    resetArtifactFailureReporterForTests();
  });

  afterEach(() => {
    resetArtifactFailureReporterForTests();
  });

  // AC1: enabling an observability feature that then fails produces at
  // least one operator-visible signal WITHOUT AFK_DEBUG=1.
  it('surfaces a write failure via console.error with AFK_DEBUG unset', async () => {
    const originalDebug = process.env['AFK_DEBUG'];
    delete process.env['AFK_DEBUG'];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const writer = makeFailingWriter('/tmp/afk-850-a/trace.jsonl', 'EACCES: permission denied');

      await emitSessionPhase(writer, { phase: 'session_init_start' });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const msg = errorSpy.mock.calls[0]?.[0];
      expect(String(msg)).toContain('session_phase');
      expect(String(msg)).toContain('EACCES');
    } finally {
      if (originalDebug !== undefined) process.env['AFK_DEBUG'] = originalDebug;
      errorSpy.mockRestore();
    }
  });

  // AC2: no turn can be failed by an artifact write. A rejecting writer must
  // never cause emitSessionPhase (or any emit* helper) to throw/reject.
  it('never rejects even when the writer throws on every call (never-throw contract)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const writer = makeFailingWriter('/tmp/afk-850-b/trace.jsonl', 'ENOSPC: no space left on device');

      await expect(emitSessionPhase(writer, { phase: 'loop_end', durationMs: 5 })).resolves.toBeUndefined();
      await expect(emitAbort(writer, { origin: 'user_signal', cascadedTo: [] })).resolves.toBeUndefined();
      // Repeat calls — still must never throw, matching the fire-and-forget
      // contract callers rely on (`void emitSessionPhase(...)`).
      await expect(emitSessionPhase(writer, { phase: 'loop_end', durationMs: 5 })).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // AC3: a forced write failure emits the signal EXACTLY ONCE per dedup key
  // (post-fix: the writer INSTANCE, matched by identity) — not zero times,
  // not once per call. A wedged writer (every call fails identically) must
  // not flood stderr.
  it('emits the visible signal exactly once per writer even across many failing calls', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const writer = makeFailingWriter('/tmp/afk-850-c/trace.jsonl', 'EROFS: read-only file system');

      await emitSessionPhase(writer, { phase: 'session_init_start' });
      await emitSessionPhase(writer, { phase: 'loop_end', durationMs: 1 });
      await emitAbort(writer, { origin: 'user_signal', cascadedTo: [] });

      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not surface anything when the writer is undefined (no-op path unaffected)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(emitSessionPhase(undefined, { phase: 'session_init_start' })).resolves.toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Regression for the CI TypeError this fix closes: a writer that has NO
  // `getTracePath` method at all (a partial/test-double TraceWriter — e.g.
  // McpManager's traceWriter mock in src/telegram/mcp-session.test.ts) must
  // not crash `emitSessionPhase` when its `write()` also fails. Pre-fix,
  // the catch block called `writer.getTracePath()` to build the dedup key,
  // which threw `TypeError: writer.getTracePath is not a function` from
  // INSIDE the catch — an unhandled rejection that reddened CI. This test
  // MUST fail against the pre-fix code (it either throws or emitSessionPhase
  // rejects, either way violating the never-throw contract).
  it('never throws when the writer has no getTracePath method at all (CI TypeError regression)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const writer = {
        write: async () => {
          throw new Error('boom');
        },
      } as unknown as TraceWriter;

      await expect(emitSessionPhase(writer, { phase: 'session_init_start' })).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const msg = errorSpy.mock.calls[0]?.[0];
      expect(String(msg)).toContain('session_phase');
      expect(String(msg)).toContain('boom');
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Regression for the shared-sentinel suppression bug: two SEPARATE writer
  // instances that both return the identical getTracePath() value (mimicking
  // InMemoryTraceWriter's shared 'in-memory://trace' sentinel — see
  // agent/trace/writer.ts) and both fail must each get their own visible
  // warning. Pre-fix (path-string dedup key), the second writer's failure
  // would have been silently swallowed into debugLog because its path
  // collided with the first writer's already-latched key.
  it('warns once PER WRITER even when two distinct writers share the identical getTracePath() value', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sharedPath = 'in-memory://trace';
      const writerOne = makeFailingWriter(sharedPath, 'writer one failure');
      const writerTwo = makeFailingWriter(sharedPath, 'writer two failure');

      await emitSessionPhase(writerOne, { phase: 'session_init_start' });
      await emitSessionPhase(writerTwo, { phase: 'session_init_start' });

      expect(errorSpy).toHaveBeenCalledTimes(2);
      const firstMsg = String(errorSpy.mock.calls[0]?.[0]);
      const secondMsg = String(errorSpy.mock.calls[1]?.[0]);
      expect(firstMsg).toContain('writer one failure');
      expect(secondMsg).toContain('writer two failure');
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Regression for the traceDedupKey self-recursion defect (superseded helper,
  // never shipped past PR #979 review): `traceDedupKey` called ITSELF instead
  // of `writer.getTracePath()` in its true branch, so every writer — including
  // ones correctly implementing getTracePath — recursed until `RangeError:
  // Maximum call stack size exceeded`, which its own catch swallowed into the
  // single sentinel key 'unknown-trace'. Two writers with DIFFERENT
  // getTracePath() values would therefore have collapsed onto that one shared
  // key, so only the FIRST writer's failure anywhere in the process was ever
  // visible — the second would have been silently downgraded to debugLog.
  // Identity-based keying never reads getTracePath() at all, so it is immune:
  // distinct instances are always distinct keys regardless of what (if
  // anything) their accessor returns.
  it('does not collapse distinct writers onto one dedup key (traceDedupKey recursion regression)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const writerOne = makeFailingWriter('/tmp/afk-850-recursion-a/trace.jsonl', 'writer A failure');
      const writerTwo = makeFailingWriter('/tmp/afk-850-recursion-b/trace.jsonl', 'writer B failure');

      await emitSessionPhase(writerOne, { phase: 'session_init_start' });
      await emitSessionPhase(writerTwo, { phase: 'session_init_start' });

      expect(errorSpy).toHaveBeenCalledTimes(2);
      const firstMsg = String(errorSpy.mock.calls[0]?.[0]);
      const secondMsg = String(errorSpy.mock.calls[1]?.[0]);
      expect(firstMsg).toContain('writer A failure');
      expect(secondMsg).toContain('writer B failure');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('#850 regression — the reporter must not become the failure it reports', () => {
  it('does not reject when a failing writer lacks getTracePath', async () => {
    // Reproduces the CI unhandled rejection: `reportArtifactFailure` guards its
    // own body, but its ARGUMENTS are evaluated first, so `writer.getTracePath()`
    // at the call site threw on a partial writer double and escaped as an
    // unhandled rejection. 4 of these failed the full suite while every test
    // still "passed".
    const partialWriter = {
      write: async () => {
        throw new Error('disk full');
      },
    } as unknown as TraceWriter;

    await expect(
      emitSessionPhase(partialWriter, { phase: 'bootstrap_start' }),
    ).resolves.toBeUndefined();
    await expect(
      emitToolCall(partialWriter, {
        phase: 'started',
        toolUseId: 'tu-1',
        name: 'bash',
        inputBytes: 4,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not reject when getTracePath itself throws', async () => {
    const hostileWriter = {
      write: async () => {
        throw new Error('disk full');
      },
      getTracePath: () => {
        throw new Error('path resolution blew up');
      },
    } as unknown as TraceWriter;

    await expect(
      emitSessionPhase(hostileWriter, { phase: 'bootstrap_start' }),
    ).resolves.toBeUndefined();
  });
});
