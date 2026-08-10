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
import { InMemoryTraceWriter, type TraceWriter } from './writer.js';
import type { TraceWriter } from './index.js';

/** A writer whose `write()` always rejects, with a real (fixed) trace path
 *  so it can serve as a stable dedup key across multiple calls. */
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
  // (here, the writer's trace path) — not zero times, not once per call. A
  // wedged writer (every call fails identically) must not flood stderr.
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
