/**
 * Constructor helpers for AgentSession.
 * @module agent/session/session-setup
 */

import { getSessionGrantsPath } from '../../paths.js';
import {
  capJsonlBySize,
  SESSION_GRANTS_MAX_BYTES,
  SESSION_GRANTS_KEEP_TAIL_LINES,
} from '../log-retention.js';
import { sweepWitnessTree, WITNESS_SWEEP_START_DELAY_MS } from '../witness-sweep.js';
import { sweepSessionSidecars, SESSION_SIDECAR_SWEEP_START_DELAY_MS } from '../session-sidecar-sweep.js';
import { sweepMemoryGc, MEMORY_GC_SWEEP_START_DELAY_MS } from '../memory/memory-gc-sweep.js';
import { debugLog } from '../../utils/debug.js';
import type {
  AgentConfig,
  SessionIdentity,
  SessionMetadata,
} from '../types.js';

/**
 * Wire an optional external abort signal to an internal AbortController.
 * Forwards abort events (preserving reason) and attaches onAbort.
 */
export function wireAbortSignal(
  external: AbortSignal | undefined,
  internal: AbortController,
  onAbort: () => void,
): void {
  if (external) {
    if (external.aborted) {
      internal.abort(external.reason);
    } else {
      external.addEventListener(
        'abort',
        () => {
          if (!internal.signal.aborted) internal.abort(external.reason);
        },
        { once: true },
      );
    }
  }
  internal.signal.addEventListener('abort', onAbort, { once: true });
}

/**
 * Build initial session identity and metadata from config.
 * Metadata model is supplied separately (resolved by buildQueryOptions).
 */
export function buildInitialState(
  config: AgentConfig,
  resolvedModel: string,
): {
  sessionIdentity: SessionIdentity;
  metadata: SessionMetadata;
} {
  const permissionMode = config.permissionMode ?? 'default';
  const persistSession = config.persistSession ?? true;

  const sessionIdentity: SessionIdentity = {
    sessionId: config.sessionId,
    configuredSessionId: config.sessionId,
    resume: config.resume,
    resumeSessionAt: config.resumeSessionAt,
    continue: config.continue,
    forkSession: config.forkSession,
    persistSession,
  };

  const metadata: SessionMetadata = {
    sessionId: config.sessionId,
    model: resolvedModel,
    permissionMode,
  };

  return { sessionIdentity, metadata };
}

/**
 * Top-level session-start housekeeping, extracted from the AgentSession
 * constructor. Callers invoke it for top-level sessions only.
 *
 * Bounds the write-only session-grants audit log: subagents share the parent's
 * path, so re-running per fork is redundant and widens the rewrite-collision
 * window. Fire-and-forget + silent-fail — best-effort housekeeping that must
 * never delay or break construction.
 *
 * Bounds the witness tree the same way. Self-throttled by a stamp file, so this
 * is a no-op on all but one session start every few hours (#849).
 *
 * Invariant: the sweeps are deferred off the construction path and
 * `.unref()`ed, exactly as BackgroundAgentRegistry's eviction sweep is. The
 * walk is O(files in the witness tree), so running it inline competes with the
 * session's own first-turn I/O. The unref also means a short-lived process
 * exits without ever paying for it.
 */
export function scheduleTopLevelHousekeeping(
  getActiveLabel: () => string | undefined,
  getActiveSessionId: () => string | undefined,
): void {
  void capJsonlBySize(getSessionGrantsPath(), {
    maxBytes: SESSION_GRANTS_MAX_BYTES,
    keepTailLines: SESSION_GRANTS_KEEP_TAIL_LINES,
  });
  const witnessSweepTimer = setTimeout(() => {
    void sweepWitnessTree({ activeLabel: getActiveLabel() });
  }, WITNESS_SWEEP_START_DELAY_MS);
  witnessSweepTimer.unref();
  const sidecarSweepTimer = setTimeout(() => {
    void sweepSessionSidecars({ activeSessionId: getActiveSessionId() });
  }, SESSION_SIDECAR_SWEEP_START_DELAY_MS);
  sidecarSweepTimer.unref();
  // Memory GC sweep — opt-in, OFF by default (AFK_MEMORY_GC_SWEEP_ENABLE=1).
  // Self-throttled to at most once per 24 hours. Fire-and-forget; never throws.
  // The sweep logs internally when it archives facts or encounters an error.
  const memoryGcTimer = setTimeout(() => {
    sweepMemoryGc().then((result) => {
      if (!result.skipped) {
        debugLog(
          `[session-setup] memory GC sweep complete: candidates=${result.candidates} archived=${result.archived}${result.error ? ` error=${result.error}` : ''}`,
        );
      }
    }).catch(() => {
      // sweepMemoryGc itself never rejects, but guard just in case.
    });
  }, MEMORY_GC_SWEEP_START_DELAY_MS);
  memoryGcTimer.unref();
}
